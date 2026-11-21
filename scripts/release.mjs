import { createHash } from "node:crypto"
import { realpathSync } from "node:fs"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { applyEdits, modify } from "jsonc-parser"
import { ensureNpmLogin, runWithAuthLinks } from "./auth-process.mjs"
import { assertPluginVersions, checkPluginVersions } from "./check-versions.mjs"
import { runCommand } from "./process.mjs"
import {
  createSession,
  flushOutput,
  loadSession,
  parseInternalArgs,
  parseResumeArgs,
  readDone,
  removeSession,
  watchSession,
  writeDone,
} from "./release-session.mjs"
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

function cacheBusted(url, enabled) {
  return enabled ? `${url}${url.includes("?") ? "&" : "?"}__release=${Date.now()}` : url
}

export async function fetchRegistryVersion(registry, name, version, { fetchImpl = fetch, cacheBust = false } = {}) {
  const response = await fetchImpl(cacheBusted(registryVersionUrl(registry, name, version), cacheBust), { headers: { accept: "application/json" } })
  if (response.status === 404) {
    // The version endpoint can stay cached as 404 after the package document has
    // already listed the version. The package document is the authoritative set.
    const packumentURL = `${registry.replace(/\/+$/, "")}/${registryPackagePath(name)}`
    const packumentResponse = await fetchImpl(cacheBusted(packumentURL, cacheBust), { headers: { accept: "application/json" } })
    if (packumentResponse.status === 404) return null
    if (!packumentResponse.ok) throw new Error(`Registry query failed for ${name}: ${packumentResponse.status}`)
    const packument = await packumentResponse.json()
    const entry = packument.versions?.[version]
    if (!entry) return null
    return { integrity: entry.dist?.integrity ?? null, tarball: entry.dist?.tarball ?? null }
  }
  if (!response.ok) throw new Error(`Registry query failed for ${name}@${version}: ${response.status}`)
  const body = await response.json()
  return { integrity: body.dist?.integrity ?? null, tarball: body.dist?.tarball ?? null }
}

export async function fetchRegistryLatest(registry, name, { fetchImpl = fetch, cacheBust = false } = {}) {
  const response = await fetchImpl(cacheBusted(`${registry.replace(/\/+$/, "")}/${registryPackagePath(name)}/latest`, cacheBust), { headers: { accept: "application/json" } })
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

export async function waitForRegistry(registry, name, version, { fetchImpl = fetch, attempts = 200, delay = 3000, log = console.error } = {}) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const remote = await fetchRegistryVersion(registry, name, version, { fetchImpl, cacheBust: true })
      if (remote) return remote
    } catch (error) {
      if (attempt === attempts - 1) throw error
    }
    if (attempt === 0) log(`[release] waiting for ${name}@${version} to appear in the registry`)
    await new Promise((resolve) => setTimeout(resolve, delay))
  }
  throw new Error(`Timed out waiting for ${name}@${version} to appear in the registry`)
}

export async function assertReleaseVersion({
  root = repository,
  registry = DEFAULT_REGISTRY,
  fetchImpl = fetch,
  allowCurrent = false,
} = {}) {
  const packages = (await workspacePackages(root)).filter((item) => item.manifest.private !== true)
  const { version } = assertPluginVersions(packages.map((item) => item.manifest))
  if (!parseVersion(version)) throw new Error(`Invalid workspace version: ${version}`)

  for (const item of packages) {
    const latest = await fetchRegistryLatest(registry, item.manifest.name, { fetchImpl, cacheBust: true })
    if (latest) {
      const comparison = compareVersions(version, latest)
      if (comparison < 0 || (comparison === 0 && !allowCurrent)) {
        throw new Error(`${item.manifest.name}@${version} is not newer than registry latest ${latest}; bump the version first`)
      }
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
    latest.push({ name: item.manifest.name, version: await fetchRegistryLatest(registry, item.manifest.name, { fetchImpl, cacheBust: true }) })
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

export async function bumpVersion({ root = repository, target } = {}) {
  if (!parseVersion(target)) throw new Error(`Invalid version: ${target}`)
  const packages = (await workspacePackages(root)).filter((item) => item.manifest.private !== true)
  for (const item of packages) {
    const file = path.join(item.directory, "package.json")
    const text = await readFile(file, "utf8")
    const next = applyEdits(text, modify(text, ["version"], target, { formattingOptions: { insertSpaces: true, tabSize: 2 } }))
    if (next !== text) await writeFile(file, next)
  }
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
  allowCurrent = false,
  log = () => {},
} = {}) {
  const { version, packages } = await assertReleaseVersion({ root, registry, fetchImpl, allowCurrent })

  const temporary = destination ?? await mkdtemp(path.join(os.tmpdir(), "unicorn-release-"))
  const owned = destination === undefined
  const levels = buildLevels(packages)
  try {
    await mkdir(temporary, { recursive: true })
    const plan = []
    for (const item of levels.flat()) {
      const packed = await pack(root, item, temporary, { run })
      const remote = await fetchRegistryVersion(registry, item.manifest.name, version, { fetchImpl, cacheBust: true })
      if (remote) {
        if (!remote.integrity) throw new Error(`Registry has no integrity for ${item.manifest.name}@${version}`)
        if (remote.integrity !== packed.integrity) {
          if (!allowCurrent) {
            throw new Error(`Content for ${item.manifest.name}@${version} differs from the registry; bump the version`)
          }
          log(`[release] ${item.manifest.name}@${version} already exists with different content; keeping the published version`)
        }
        plan.push({ name: item.manifest.name, version, ...packed, action: "skip" })
      } else {
        plan.push({ name: item.manifest.name, version, ...packed, action: "publish" })
      }
    }
    return {
      version,
      plan,
      levels: levels.map((level) => level.map((item) => item.manifest.name)),
      temporary,
      cleanup: async () => { if (owned) await rm(temporary, { recursive: true, force: true }) },
    }
  } catch (error) {
    if (owned) await rm(temporary, { recursive: true, force: true })
    throw error
  }
}

async function commitPackageVersions({ root = repository, target, run = runCommand, log = (...values) => console.error(...values) } = {}) {
  const files = (await workspacePackages(root))
    .filter((item) => item.manifest.private !== true)
    .map((item) => path.relative(root, path.join(item.directory, "package.json")).split(path.sep).join("/"))
  const expected = new Set(files)
  await run(["git", "add", "--", ...files], { cwd: root })
  const staged = (await run(["git", "diff", "--cached", "--name-only"], { cwd: root, capture: true })).trim()
  if (!staged) return { commit: null, message: null }
  const unexpected = staged.split("\n").filter(Boolean).filter((file) => !expected.has(file))
  if (unexpected.length) throw new Error(`Refusing to commit non-package changes: ${unexpected.join(", ")}`)
  const message = `release: v${target} [local-publish]`
  await run(["git", "commit", "-m", message], { cwd: root })
  const commit = (await run(["git", "rev-parse", "--short", "HEAD"], { cwd: root, capture: true })).trim()
  log(`[release] committed ${commit} ${message}`)
  return { commit, message }
}

async function assertTrustedPublishingPackages({ packages, registry, fetchImpl, log }) {
  const missing = []
  for (const item of packages) {
    const latest = await fetchRegistryLatest(registry, item.manifest.name, { fetchImpl, cacheBust: true })
    if (!latest) missing.push(item.manifest.name)
  }
  if (missing.length) {
    throw new Error(
      `Cannot publish new package(s) with npm trusted publishing: ${missing.join(", ")}. ` +
      `Trusted publishing only authenticates packages that already exist on ${registry}. ` +
      `Bootstrap the first version with local npm authentication or an NPM_TOKEN, then rerun the release workflow.`,
    )
  }
  log(`[release] trusted publishing preflight: ${packages.length} packages already exist`)
}

export async function releasePackages({
  root = repository,
  registry = DEFAULT_REGISTRY,
  tag = "latest",
  stage = false,
  dryRun = false,
  build = true,
  run = runCommand,
  authRun = run,
  fetchImpl = fetch,
  log = (...values) => console.error(...values),
  pack,
  verify = true,
  allowCurrent = false,
  trustedPublishing = false,
} = {}) {
  const release = await assertReleaseVersion({ root, registry, fetchImpl, allowCurrent })
  if (trustedPublishing) {
    await assertTrustedPublishingPackages({ packages: release.packages, registry, fetchImpl, log })
  }

  if (build) {
    log("[release] building")
    await run(["bun", "run", "build"], { cwd: root })
  }

  const planned = await planRelease({ root, registry, fetchImpl, run, pack, allowCurrent, log })
  try {
    const published = planned.plan.filter((item) => item.action !== "skip")
    log(`[release] ${planned.version}: ${published.length} to ${stage ? "stage" : "publish"}, ${planned.plan.length - published.length} already present`)

    if (dryRun) {
      return { dryRun: true, version: planned.version, stage, packages: planned.plan.map(({ file, integrity, ...item }) => item) }
    }

    if (stage) {
      for (const item of planned.plan) {
        if (item.action === "skip") {
          log(`[release] skip ${item.name}@${item.version}`)
          continue
        }
        log(`[release] staging ${item.name}@${item.version}`)
        const command = ["npm", "stage", "publish", item.file, "--access", "public", "--ignore-scripts", `--tag=${tag}`, `--registry=${registry}`, "--update-notifier=false"]
        await authRun(command, { cwd: root })
      }
    } else if (published.length > 0) {
      const byName = new Map(published.map((item) => [item.name, item]))
      const publishLevels = planned.levels
        .map((level) => level.map((name) => byName.get(name)).filter((item) => item !== undefined))
        .filter((level) => level.length > 0)
      const grouped = new Set(publishLevels.flatMap((level) => level.map((item) => item.name)))
      const omitted = published.filter((item) => !grouped.has(item.name)).map((item) => item.name)
      if (omitted.length) throw new Error(`Release plan omitted packages from dependency levels: ${omitted.join(", ")}`)
      for (const level of publishLevels) {
        log(`[release] publishing ${level.map((item) => `${item.name}@${item.version}`).join(", ")}`)
        const command = [
          "npm", "publish",
          ...level.flatMap((item) => ["--workspace", item.name]),
          "--access", "public", "--ignore-scripts", `--tag=${tag}`, `--registry=${registry}`, "--update-notifier=false",
        ]
        try {
          await authRun(command, { cwd: root })
        } catch (error) {
          // npm's web-auth polling can report 404/E404 after the registry accepted the
          // upload. Treat the level as published only when every exact version exists.
          const missing = []
          for (const item of level) {
            const remote = await fetchRegistryVersion(registry, item.name, item.version, { fetchImpl })
            if (!remote) missing.push(item.name)
          }
          if (missing.length) throw error
          log(`[release] ${level.map((item) => item.name).join(", ")} are present despite the CLI error; continuing`)
        }
      }
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
    const packages = (await workspacePackages(root)).filter((item) => item.manifest.private !== true)
    await assertTrustedPublishingPackages({ packages, registry: options.registry, fetchImpl, log })
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

  await run(["npm", "run", "check:release"], { cwd: root })
  await assertCleanWorkspace({ root, run })
  await bumpVersion({ root, target: resolved.target })
  await assertCleanWorkspace({ root, run, allowVersion: true })

  const authRun = (command, options = {}) => runWithAuthLinks(command, {
    cwd: options.cwd ?? root,
    env: options.env ?? process.env,
    log,
    authEventFile: process.env.RELEASE_AUTH_EVENT_FILE,
  })
  if (!ci) await ensureNpmLogin({ registry: options.registry, run, authRun, log })

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
    authRun,
    fetchImpl,
    log,
    verify: options.releaseType !== "local-publish",
    ...overrides,
  })
  if (options.releaseType === "local-publish") {
    const committed = await commitPackageVersions({ root, target: resolved.target, run, log })
    return { releaseType: options.releaseType, ...result, ...committed }
  }
  return { releaseType: options.releaseType, ...result }
}

function resumableRelease(args) {
  const options = parseReleaseArgs(args)
  return !options.dryRun && (options.releaseType === "local-publish" || options.releaseType === "local-stage")
    ? options
    : null
}

async function finishSession(result) {
  if (result.type === "auth") return 0
  if (result.type === "done") {
    if (result.code === 0) {
      console.log(JSON.stringify(result.result ?? { status: "completed" }))
      return 0
    }
    const message = result.error?.message ?? "Release failed"
    console.error(message)
    console.log(JSON.stringify({ status: "failed", message }))
    return result.code || 1
  }
  if (result.type === "crashed") {
    const message = result.state?.error?.message ?? "Release process exited unexpectedly"
    console.error(message)
    console.log(JSON.stringify({ status: "failed", message }))
    return 1
  }
  return 1
}

async function startResumableRelease(args, options) {
  console.log(options.releaseType === "local-stage" ? "Checking before stage" : "Checking before publish")
  const session = createSession({ args })
  console.log(`[release] session ${session.id}: ${session.directory}`)
  const result = await watchSession(session)
  const code = await finishSession(result)
  if (result.type === "done" && result.code === 0 && !removeSession(session)) {
    console.error(`[release] could not remove session ${session.directory}`)
  }
  return code
}

async function resumeRelease(id) {
  const session = loadSession(id)
  console.log(`Resuming release session ${id}`)
  if (!readDone(session)) console.log("[release] Resuming; this command blocks until browser authorization and the release finish")
  const result = await watchSession(session, { continueOnAuth: true })
  const code = await finishSession(result)
  if (result.type === "done" && result.code === 0 && !removeSession(session)) {
    console.error(`[release] could not remove session ${session.directory}`)
  }
  return code
}

async function runInternal(args, sessionDir) {
  try {
    const result = await release({ args })
    if (sessionDir) console.log("[release] completed")
    flushOutput()
    if (sessionDir) writeDone(sessionDir, { code: 0, result })
    else console.log(JSON.stringify(result))
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error(error)
    flushOutput()
    if (sessionDir) {
      try {
        writeDone(sessionDir, {
          code: 1,
          error: {
            message,
            ...(error instanceof Error && error.stack ? { stack: error.stack } : {}),
          },
        })
      } catch (doneError) {
        console.error(doneError)
      }
    } else {
      console.log(JSON.stringify({ status: "failed", message }))
    }
    process.exitCode = 1
  }
}

function isMainModule() {
  if (!process.argv[1]) return false
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
}

if (isMainModule()) {
  try {
    const argv = process.argv.slice(2)
    const internal = parseInternalArgs(argv)
    if (internal.internal) {
      await runInternal(internal.args, internal.sessionDir)
    } else if (argv.includes("--help") || argv.includes("-h")) {
      console.log([
        "npm run release -- --release-type=<type> [--version=<spec>] [--tag=latest] [--registry=...] [--dry-run]",
        "npm run release -- --release-type=<type> [options] --resume <session-id>",
        "",
        "release-type: local-publish | local-stage | ci-publish | ci-stage",
        "version:      patch (default) | minor | major | explicit semver",
        "",
        "The command validates arguments, requires a clean workspace, runs the full check,",
        "bumps every package to the same target version, then publishes or triggers CI.",
        "",
        "Local releases stop at the first npm auth URL and print a resume command.",
        "Run the resume command immediately. It prints any further auth URLs and blocks until the release finishes.",
      ].join("\n"))
    } else {
      const resume = parseResumeArgs(argv)
      const resumable = resume.resume ? null : resumableRelease(argv)
      if (resume.resume) {
        process.exitCode = await resumeRelease(resume.resume)
      } else if (resumable) {
        process.exitCode = await startResumableRelease(argv, resumable)
      } else {
        const result = await release({ args: argv })
        console.log(JSON.stringify(result))
      }
    }
  } catch (error) {
    console.log(JSON.stringify({ status: "failed", message: error.message }))
    console.error(error)
    process.exitCode = 1
  }
}
