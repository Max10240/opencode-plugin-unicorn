import { createHash } from "node:crypto"
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { assertPluginVersions, checkPluginVersions } from "./check-versions.mjs"
import { runCommand } from "./process.mjs"
import { syncPluginDependencies } from "./sync-plugin-dependencies.mjs"
import { buildLevels, workspacePackages } from "./workspace.mjs"

const repository = fileURLToPath(new URL("../", import.meta.url))
export const DEFAULT_REGISTRY = "https://registry.npmjs.org/"
export const UNICORN_NAME = "@max10240/opencode-plugin-unicorn"
export const RELEASE_TYPES = ["local-publish", "local-stage", "ci-publish", "ci-stage"]
export const SYNC_PATHS = [
  "packages/opencode-plugin-recomended-opencode-config/rules/AGENTS.md",
  "packages/opencode-plugin-recomended-opencode-config/rules/commands.json",
]

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

export function parseReleaseArgs(args = []) {
  const options = { releaseType: null, version: "patch", tag: "latest", registry: DEFAULT_REGISTRY, dryRun: false }
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]
    if (arg.startsWith("--release-type=")) { options.releaseType = arg.slice("--release-type=".length); continue }
    if (arg === "--release-type") { options.releaseType = args[++index]; continue }
    if (arg.startsWith("--version=")) { options.version = arg.slice("--version=".length); continue }
    if (arg === "--version") { options.version = args[++index]; continue }
    if (arg.startsWith("--tag=")) { options.tag = arg.slice("--tag=".length); continue }
    if (arg === "--tag") { options.tag = args[++index]; continue }
    if (arg.startsWith("--registry=")) { options.registry = arg.slice("--registry=".length); continue }
    if (arg === "--registry") { options.registry = args[++index]; continue }
    if (arg === "--dry-run") { options.dryRun = true; continue }
    throw new Error(`Unknown release option: ${arg}`)
  }

  if (!options.releaseType) throw new Error(`Missing required --release-type. Use one of: ${RELEASE_TYPES.join(", ")}`)
  if (!RELEASE_TYPES.includes(options.releaseType)) throw new Error(`Invalid --release-type: ${options.releaseType}. Use one of: ${RELEASE_TYPES.join(", ")}`)
  if (!["patch", "minor", "major"].includes(options.version) && !parseVersion(options.version)) {
    throw new Error(`Invalid --version: ${options.version}. Use patch, minor, major, or an explicit semver such as 1.2.0.`)
  }
  if (!options.tag) throw new Error("--tag must not be empty")
  if (!options.registry) throw new Error("--registry requires a value")
  const url = new URL(options.registry)
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("Release registry must be HTTP or HTTPS")

  const ci = options.releaseType.startsWith("ci-")
  if (ci && options.tag !== "latest") throw new Error("--tag is not supported for ci release types")
  if (ci && url.href !== new URL(DEFAULT_REGISTRY).href) throw new Error("ci release types require the npmjs registry")
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

export async function resolveTargetVersion({
  root = repository,
  registry = DEFAULT_REGISTRY,
  spec = "patch",
  fetchImpl = fetch,
} = {}) {
  const packages = (await workspacePackages(root)).filter((item) => item.manifest.private !== true)
  const { version: localVersion } = assertPluginVersions(packages.map((item) => item.manifest))
  if (!parseVersion(localVersion)) throw new Error(`Invalid workspace version: ${localVersion}`)

  const latest = []
  for (const item of packages) {
    latest.push({ name: item.manifest.name, version: await fetchRegistryLatest(registry, item.manifest.name, { fetchImpl }) })
  }
  const registryMax = latest.map((item) => item.version).filter(Boolean).sort(compareVersions).at(-1) ?? null

  if (["patch", "minor", "major"].includes(spec)) {
    const base = registryMax && compareVersions(registryMax, localVersion) > 0 ? registryMax : localVersion
    const parsed = parseVersion(base)
    const target = spec === "patch"
      ? `${parsed.major}.${parsed.minor}.${parsed.patch + 1}`
      : spec === "minor"
        ? `${parsed.major}.${parsed.minor + 1}.0`
        : `${parsed.major + 1}.0.0`
    return { target, localVersion, registryMax, packages, latest }
  }

  const target = spec
  if (!parseVersion(target)) throw new Error(`Invalid version: ${target}`)
  if (registryMax && compareVersions(target, registryMax) <= 0) {
    throw new Error(`Target ${target} must be greater than registry latest ${registryMax}`)
  }
  if (compareVersions(target, localVersion) < 0) {
    throw new Error(`Target ${target} must not be lower than local version ${localVersion}`)
  }
  return { target, localVersion, registryMax, packages, latest }
}

function statusPath(line) {
  let value = line.slice(3)
  if (value.includes(" -> ")) value = value.split(" -> ").at(-1)
  return value.replace(/^"|"$/g, "")
}

export async function assertCleanWorkspace({
  root = repository,
  run = runCommand,
  allowVersion = false,
} = {}) {
  const output = await run(["git", "status", "--porcelain"], { cwd: root, capture: true })
  const lines = output.split("\n").map((line) => line.trimEnd()).filter(Boolean)
  const unexpected = lines.filter((line) => {
    const file = statusPath(line)
    if (SYNC_PATHS.includes(file)) return false
    if (allowVersion && /^packages\/[^/]+\/package\.json$/.test(file)) return false
    return true
  })
  if (unexpected.length) {
    throw new Error(`Workspace is not clean: ${unexpected.join(", ")}`)
  }
  return lines
}

export async function bumpVersion({ root = repository, target, run = runCommand } = {}) {
  await run([
    "npm", "version", target, "--workspaces", "--allow-same-version", "--ignore-scripts",
    "--git-tag-version=false", "--workspaces-update=false", "--include-workspace-root=false", "--update-notifier=false",
  ], { cwd: root })
  await syncPluginDependencies(root)
  await checkPluginVersions(root)
}

export async function triggerCi({ root = repository, target, stage = false, run = runCommand } = {}) {
  const branch = (await run(["git", "rev-parse", "--abbrev-ref", "HEAD"], { cwd: root, capture: true })).trim()
  if (branch !== "main") throw new Error(`ci release requires main, current branch is ${branch}`)
  await run(["git", "add", "packages"], { cwd: root })
  const staged = (await run(["git", "diff", "--cached", "--name-only"], { cwd: root, capture: true })).trim()
  const message = `release: v${target} ${stage ? "[release:stage]" : "[release]"}`
  if (staged) await run(["git", "commit", "-m", message], { cwd: root })
  else await run(["git", "commit", "--allow-empty", "-m", message], { cwd: root })
  await run(["git", "push", "origin", "main"], { cwd: root })
  const commit = (await run(["git", "rev-parse", "--short", "HEAD"], { cwd: root, capture: true })).trim()
  return { commit, message }
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

export async function release({
  root = repository,
  args = [],
  run = runCommand,
  fetchImpl = fetch,
  log = (...values) => console.error(...values),
  ...overrides
} = {}) {
  const options = parseReleaseArgs(args)
  const ci = options.releaseType.startsWith("ci-")
  const stage = options.releaseType.endsWith("stage")

  await assertCleanWorkspace({ root, run })
  if (ci) {
    const branch = (await run(["git", "rev-parse", "--abbrev-ref", "HEAD"], { cwd: root, capture: true })).trim()
    if (branch !== "main") throw new Error(`ci release requires main, current branch is ${branch}`)
  }

  const resolved = await resolveTargetVersion({ root, registry: options.registry, spec: options.version, fetchImpl })
  log(`[release] ${options.releaseType}: ${resolved.localVersion} -> ${resolved.target}`)

  if (options.dryRun) {
    return {
      dryRun: true,
      releaseType: options.releaseType,
      from: resolved.localVersion,
      to: resolved.target,
      registryMax: resolved.registryMax,
    }
  }

  await run(["npm", "run", "check"], { cwd: root })
  await assertCleanWorkspace({ root, run })
  await bumpVersion({ root, target: resolved.target, run })
  await assertCleanWorkspace({ root, run, allowVersion: true })

  if (ci) {
    const result = await triggerCi({ root, target: resolved.target, stage, run })
    return { releaseType: options.releaseType, version: resolved.target, ...result }
  }

  const result = await releasePackages({
    root,
    registry: options.registry,
    tag: options.tag,
    stage,
    build: true,
    run,
    fetchImpl,
    log,
    ...overrides,
  })
  return { releaseType: options.releaseType, ...result }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const argv = process.argv.slice(2)
    if (argv.includes("--help") || argv.includes("-h")) {
      console.log([
        "npm run release -- --release-type=<type> [--version=<spec>] [--tag=latest] [--registry=...] [--dry-run]",
        "",
        "release-type: local-publish | local-stage | ci-publish | ci-stage",
        "version:      patch (default) | minor | major | explicit semver",
        "",
        "The command validates arguments, requires a clean workspace, runs the full check,",
        "bumps every package to the same target version, then publishes or triggers CI.",
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
