import { createHash, randomUUID } from "node:crypto"
import { mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { BUILD_MANIFEST, buildFingerprint, mapLimit, workspacePackages } from "./workspace.mjs"
import { runCommand, timed } from "./process.mjs"

const repository = fileURLToPath(new URL("../", import.meta.url))
const builds = new Map()
const digest = (value) => createHash("sha256").update(value).digest("hex")

export async function verifyBuild(root, manifest) {
  if (manifest.root !== root || manifest.fingerprint !== await buildFingerprint(root)) throw new Error("Test build is stale; run the workflow again")
}

export async function ensureBuilt(root = repository, { env = process.env, run = runCommand } = {}) {
  if (env[BUILD_MANIFEST]) {
    const manifest = JSON.parse(await readFile(env[BUILD_MANIFEST], "utf8"))
    await verifyBuild(root, manifest)
    return manifest
  }
  if (!builds.has(root)) {
    const pending = (async () => {
      await run(["bun", "run", "build"], { cwd: root })
      return { root, fingerprint: await buildFingerprint(root) }
    })()
    builds.set(root, pending)
    pending.catch(() => builds.delete(root))
  }
  const manifest = await builds.get(root)
  await verifyBuild(root, manifest)
  return manifest
}

export async function packWorkspace(destination, { root = repository, run = runCommand, env = process.env } = {}) {
  const build = await ensureBuilt(root, { env, run })
  await mkdir(destination, { recursive: true })
  if (build.archives) {
    const packages = await workspacePackages(root)
    if (build.archives.length !== packages.length) throw new Error("Incomplete test archive lease")
    const copied = await Promise.all(build.archives.map(async (item) => {
      const bytes = await readFile(item.file)
      if (digest(bytes) !== item.digest) throw new Error("Test archive changed after packing")
      const file = path.join(destination, path.basename(item.file))
      await writeFile(file, bytes)
      return { ...item, file }
    }))
    await verifyBuild(root, build)
    return copied
  }
  const archives = await mapLimit(await workspacePackages(root), 2, async (item) => {
    const output = await run(["npm", "pack", "--ignore-scripts", "--json", "--pack-destination", destination], { cwd: item.directory, capture: true })
    const packed = JSON.parse(output)
    if (packed.length !== 1 || packed[0].version !== item.manifest.version || path.basename(packed[0].filename) !== packed[0].filename) throw new Error(`Invalid archive: ${item.manifest.name}`)
    return { ...item, file: path.join(destination, packed[0].filename), packed: packed[0] }
  })
  await verifyBuild(root, build)
  return archives
}

const INSTALL_FLAGS = ["--registry=https://registry.npmjs.org/", "--ignore-scripts", "--no-audit", "--no-fund", "--package-lock=true", "--lockfile-version=3", "--update-notifier=false"]

export function installerEnvironment(install, parent = process.env) {
  return {
    PATH: parent.PATH ?? "/usr/bin:/bin", HOME: install, TMPDIR: parent.TMPDIR ?? os.tmpdir(),
    ...(parent.SystemRoot ? { SystemRoot: parent.SystemRoot } : {}),
    ...Object.fromEntries(["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy", "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "SSL_CERT_DIR"].filter((name) => parent[name] !== undefined).map((name) => [name, parent[name]])),
    npm_config_userconfig: path.join(install, ".npmrc"),
    npm_config_globalconfig: path.join(install, ".npmrc-global"),
  }
}

export function dependencyKey(archives, runtime) {
  return digest(JSON.stringify({ format: 2, runtime, flags: INSTALL_FLAGS, packages: archives.map((item) => [item.manifest, path.basename(item.file)]).sort(([a], [b]) => a.name.localeCompare(b.name)) }))
}

export async function archivePackage(archives, install) {
  return { name: "unicorn-packaged-test", private: true, dependencies: Object.fromEntries([...archives].sort((a, b) => a.manifest.name.localeCompare(b.manifest.name)).map((item) => [
    item.manifest.name, `file:${path.relative(install, item.file).split(path.sep).join("/")}`,
  ])) }
}

export async function refreshLocalIntegrities(lock, archives, manifest) {
  const next = structuredClone(lock)
  if (next.lockfileVersion !== 3 || !next.packages?.[""] || JSON.stringify(next.packages[""].dependencies) !== JSON.stringify(manifest.dependencies)) throw new Error("Cached dependency lock does not match archives")
  for (const item of archives) {
    const entry = next.packages[`node_modules/${item.manifest.name}`]
    const reference = manifest.dependencies[item.manifest.name]
    if (!entry || entry.version !== item.manifest.version || entry.resolved !== reference) throw new Error("Cached local package does not match archive")
    entry.integrity = `sha512-${createHash("sha512").update(await readFile(item.file)).digest("base64")}`
  }
  return next
}

export async function installArchives(archives, install, {
  cache = process.env.UNICORN_TEST_CACHE_DIR ?? path.join(os.tmpdir(), "opencode", "unicorn-test-cache"),
  fresh = process.env.UNICORN_TEST_FRESH_INSTALL === "1", run = runCommand,
  runtime,
} = {}) {
  await mkdir(install, { recursive: true })
  install = await realpath(install)
  archives = await Promise.all(archives.map(async (item) => ({ ...item, file: await realpath(item.file) })))
  const env = installerEnvironment(install)
  await writeFile(env.npm_config_userconfig, "")
  await writeFile(env.npm_config_globalconfig, "")
  if (!runtime) {
    const versions = await Promise.all(["node", "npm", "bun"].map((binary) => run([binary, "--version"], { capture: true, env })))
    runtime = { node: versions[0].trim(), npm: versions[1].trim(), bun: versions[2].trim(), platform: process.platform, arch: process.arch }
  }
  const key = dependencyKey(archives, runtime)
  const record = path.join(cache, "locks", `${key}.json`)
  const manifest = await archivePackage(archives, install)
  const flags = [...INSTALL_FLAGS, "--cache", path.join(cache, "npm")]
  await rm(path.join(install, "node_modules"), { recursive: true, force: true })
  await rm(path.join(install, "package-lock.json"), { force: true })
  await writeFile(path.join(install, "package.json"), JSON.stringify(manifest))
  let cached
  if (!fresh) {
    try {
      const stored = JSON.parse(await readFile(record, "utf8"))
      if (stored.key !== key || stored.digest !== digest(JSON.stringify(stored.lock))) throw new Error("Invalid dependency cache")
      cached = await refreshLocalIntegrities(stored.lock, archives, manifest)
    } catch { /* A missing or invalid cache always falls back to a fresh install. */ }
  }
  if (cached) {
    await writeFile(path.join(install, "package-lock.json"), JSON.stringify(cached))
    try {
      await timed("npm ci (cached lock, offline)", () => run(["npm", "ci", "--prefix", install, "--offline", ...flags], { cwd: install, env, capture: true }))
      return { cached: true, key }
    } catch {
      // Never reuse a partial node_modules tree or a lock whose cache entries are unavailable.
      await rm(path.join(install, "node_modules"), { recursive: true, force: true })
      await rm(path.join(install, "package-lock.json"), { force: true })
    }
  }
  await timed("npm install (fresh resolution)", () => run(["npm", "install", "--prefix", install, ...flags], { cwd: install, env, capture: true }))
  const lock = JSON.parse(await readFile(path.join(install, "package-lock.json"), "utf8"))
  await refreshLocalIntegrities(lock, archives, manifest)
  await mkdir(path.dirname(record), { recursive: true })
  const temporary = `${record}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, JSON.stringify({ key, lock, digest: digest(JSON.stringify(lock)) }), { mode: 0o600 })
    await rename(temporary, record)
  } finally { await rm(temporary, { force: true }) }
  return { cached: false, key }
}
