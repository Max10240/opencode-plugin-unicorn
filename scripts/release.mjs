import { createHash } from "node:crypto"
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { assertPluginVersions, checkPluginVersions } from "./check-versions.mjs"
import { runCommand } from "./process.mjs"
import { buildLevels, workspacePackages } from "./workspace.mjs"

const repository = fileURLToPath(new URL("../", import.meta.url))
export const DEFAULT_REGISTRY = "https://registry.npmjs.org/"
export const UNICORN_NAME = "@max10240/opencode-plugin-unicorn"

export function parseVersion(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(version ?? "")
  if (!match) return null
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]), prerelease: match[4] ?? null }
}

export function compareVersions(left, right) {
  const a = parseVersion(left)
  const b = parseVersion(right)
  if (!a || !b) throw new Error(`Invalid version comparison: ${left} / ${right}`)
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch
}

export function registryPackagePath(name) {
  if (!name.startsWith("@")) return encodeURIComponent(name)
  const slash = name.indexOf("/")
  if (slash === -1) return encodeURIComponent(name)
  return `${name.slice(0, slash)}%2F${encodeURIComponent(name.slice(slash + 1))}`
}

export function registryVersionUrl(registry, name, version) {
  return `${registry.replace(/\/+$/, "")}/${registryPackagePath(name)}/${encodeURIComponent(version)}`
}

export function tarballIntegrity(bytes) {
  return `sha512-${createHash("sha512").update(bytes).digest("base64")}`
}

export async function fetchRegistryVersion(registry, name, version, { fetchImpl = fetch } = {}) {
  const response = await fetchImpl(registryVersionUrl(registry, name, version), { headers: { accept: "application/json" } })
  if (response.status === 404) return null
  if (!response.ok) throw new Error(`Registry query failed for ${name}@${version}: ${response.status}`)
  const body = await response.json()
  return { integrity: body.dist?.integrity ?? null, tarball: body.dist?.tarball ?? null }
}

export async function fetchRegistryLatest(registry, name, { fetchImpl = fetch } = {}) {
  const response = await fetchImpl(`${registry.replace(/\/+$/, "")}/${registryPackagePath(name)}/latest`, { headers: { accept: "application/json" } })
  if (response.status === 404) return null
  if (!response.ok) throw new Error(`Registry query failed for ${name}: ${response.status}`)
  const body = await response.json()
  return body.version ?? null
}

export function releaseOptions(args = []) {
  const options = { stage: false, dryRun: false, build: true, tag: "latest", registry: DEFAULT_REGISTRY }
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]
    if (arg === "--stage") { options.stage = true; continue }
    if (arg === "--dry-run") { options.dryRun = true; continue }
    if (arg === "--no-build") { options.build = false; continue }
    if (arg.startsWith("--tag=")) { options.tag = arg.slice("--tag=".length); continue }
    if (arg === "--tag") { options.tag = args[++index]; continue }
    if (arg.startsWith("--registry=")) { options.registry = arg.slice("--registry=".length); continue }
    if (arg === "--registry") { options.registry = args[++index]; continue }
    throw new Error(`Unknown release option: ${arg}`)
  }
  const url = new URL(options.registry)
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("Release registry must be HTTP or HTTPS")
  return options
}

async function defaultPack(root, item, destination, { run = runCommand } = {}) {
  const output = await run([
    "npm", "pack", item.directory, "--json", "--ignore-scripts",
    `--pack-destination=${destination}`, "--update-notifier=false",
  ], { cwd: root, capture: true })
  const start = output.indexOf("[")
  const end = output.lastIndexOf("]")
  if (start === -1 || end === -1) throw new Error(`npm pack did not return JSON for ${item.manifest.name}`)
  const packed = JSON.parse(output.slice(start, end + 1))
  if (packed.length !== 1) throw new Error(`npm pack returned an unexpected result for ${item.manifest.name}`)
  const file = path.join(destination, path.basename(packed[0].filename))
  const bytes = await readFile(file)
  return { file, integrity: tarballIntegrity(bytes), filename: path.basename(file) }
}

async function waitForRegistry(registry, name, version, { fetchImpl = fetch, attempts = 40, delay = 3000, log = console.error } = {}) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const remote = await fetchRegistryVersion(registry, name, version, { fetchImpl })
    if (remote) return remote
    if (attempt === 0) log(`[release] waiting for ${name}@${version} to appear in the registry`)
    await new Promise((resolve) => setTimeout(resolve, delay))
  }
  throw new Error(`Timed out waiting for ${name}@${version} to appear in the registry`)
}

export async function assertReleaseVersion({
  root = repository,
  registry = DEFAULT_REGISTRY,
  fetchImpl = fetch,
} = {}) {
  const packages = (await workspacePackages(root)).filter((item) => item.manifest.private !== true)
  const { version } = assertPluginVersions(packages.map((item) => item.manifest))
  if (!parseVersion(version)) throw new Error(`Invalid workspace version: ${version}`)

  for (const item of packages) {
    const latest = await fetchRegistryLatest(registry, item.manifest.name, { fetchImpl })
    if (latest && compareVersions(version, latest) <= 0) {
      throw new Error(`${item.manifest.name}@${version} is not newer than registry latest ${latest}; bump the version first`)
    }
  }
  return { version, packages }
}

export async function planRelease({
  root = repository,
  registry = DEFAULT_REGISTRY,
  fetchImpl = fetch,
  pack = defaultPack,
  run = runCommand,
  destination,
} = {}) {
  const { version, packages } = await assertReleaseVersion({ root, registry, fetchImpl })

  const temporary = destination ?? await mkdtemp(path.join(os.tmpdir(), "unicorn-release-"))
  const owned = destination === undefined
  try {
    await mkdir(temporary, { recursive: true })
    const plan = []
    for (const item of buildLevels(packages).flat()) {
      const packed = await pack(root, item, temporary, { run })
      const remote = await fetchRegistryVersion(registry, item.manifest.name, version, { fetchImpl })
      if (remote) {
        if (!remote.integrity) throw new Error(`Registry has no integrity for ${item.manifest.name}@${version}`)
        if (remote.integrity !== packed.integrity) {
          throw new Error(`Content for ${item.manifest.name}@${version} differs from the registry; bump the version`)
        }
        plan.push({ name: item.manifest.name, version, ...packed, action: "skip" })
      } else {
        plan.push({ name: item.manifest.name, version, ...packed, action: "publish" })
      }
    }
    return { version, plan, temporary, cleanup: async () => { if (owned) await rm(temporary, { recursive: true, force: true }) } }
  } catch (error) {
    if (owned) await rm(temporary, { recursive: true, force: true })
    throw error
  }
}

export async function releasePackages({
  root = repository,
  registry = DEFAULT_REGISTRY,
  tag = "latest",
  stage = false,
  dryRun = false,
  build = true,
  run = runCommand,
  fetchImpl = fetch,
  log = (...values) => console.error(...values),
  pack,
  verify = true,
} = {}) {
  // Fail before paying for a cold build when the workspace version is stale.
  await assertReleaseVersion({ root, registry, fetchImpl })

  if (build) {
    log("[release] building")
    await run(["bun", "run", "build"], { cwd: root })
  }

  const planned = await planRelease({ root, registry, fetchImpl, run, pack })
  try {
    const published = planned.plan.filter((item) => item.action !== "skip")
    log(`[release] ${planned.version}: ${published.length} to ${stage ? "stage" : "publish"}, ${planned.plan.length - published.length} already present`)

    if (dryRun) {
      return { dryRun: true, version: planned.version, stage, packages: planned.plan.map(({ file, integrity, ...item }) => item) }
    }

    for (const item of planned.plan) {
      if (item.action === "skip") {
        log(`[release] skip ${item.name}@${item.version}`)
        continue
      }
      log(`[release] ${stage ? "staging" : "publishing"} ${item.name}@${item.version}`)
      const command = stage
        ? ["npm", "stage", "publish", item.file, "--access", "public", "--ignore-scripts", `--tag=${tag}`, `--registry=${registry}`, "--update-notifier=false"]
        : ["npm", "publish", item.file, "--access", "public", "--ignore-scripts", `--tag=${tag}`, `--registry=${registry}`, "--update-notifier=false"]
      await run(command, { cwd: root })
    }

    if (stage) {
      return { version: planned.version, stage: true, staged: published.map((item) => item.name) }
    }

    if (verify) {
      await Promise.all(published.map((item) => waitForRegistry(registry, item.name, item.version, { fetchImpl, log })))
    }
    return { version: planned.version, stage: false, published: published.map((item) => item.name), skipped: planned.plan.filter((item) => item.action === "skip").map((item) => item.name) }
  } finally {
    await planned.cleanup()
  }
}

export async function release({ root = repository, args = [], ...overrides } = {}) {
  const options = releaseOptions(args)
  return releasePackages({ root, ...options, ...overrides })
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const argv = process.argv.slice(2)
    if (argv.includes("--help") || argv.includes("-h")) {
      console.log([
        "npm run release                  Build and publish the current version",
        "npm run release:stage            Build and stage the current version for npm approval",
        "npm run release -- --dry-run     Build and validate without publishing",
        "Version is controlled by package.json; this command never bumps it.",
        "The target version must be newer than every package's registry latest.",
      ].join("\n"))
    } else {
      const result = await release({ args: argv })
      console.log(JSON.stringify(result))
    }
  } catch (error) {
    console.log(JSON.stringify({ status: "failed", message: error.message }))
    console.error(error)
    process.exitCode = 1
  }
}
