import { createHash } from "node:crypto"
import { execFileSync } from "node:child_process"
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { treeFiles } from "./workspace.mjs"

export const CHECK_CACHE_VERSION = 1
const EXCLUDED = new Set(["node_modules", "dist", "coverage", ".git", "__local_test"])

function digest(value) {
  return createHash("sha256").update(value).digest("hex")
}

export function checkCacheDirectory(environment = process.env) {
  return path.join(environment.UNICORN_TEST_CACHE_DIR ?? path.join(os.tmpdir(), "opencode", "unicorn-test-cache"), "check")
}

export function cacheKey(parts) {
  return digest(JSON.stringify(parts))
}

let runtime
export function checkRuntime(environment = process.env) {
  if (runtime) return runtime
  const version = (binary, args) => {
    try {
      return execFileSync(binary, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 10_000 }).trim()
    } catch {
      return "unavailable"
    }
  }
  runtime = {
    bun: version("bun", ["--version"]),
    npm: version("npm", ["--version"]),
    node: process.version,
    opencode: version(environment.OPENCODE_BIN ?? "opencode", ["--version"]),
    tmux: version("tmux", ["-V"]),
    platform: process.platform,
    arch: process.arch,
  }
  return runtime
}

export async function snapshotRepository(root, packages) {
  const absolute = await treeFiles(root, EXCLUDED)
  const files = await Promise.all(absolute.map(async (file) => ({
    absolute: file,
    relative: path.relative(root, file).split(path.sep).join("/"),
    hash: createHash("sha256").update(await readFile(file)).digest("hex"),
  })))
  const rootFiles = []
  const scriptFiles = []
  const testFiles = []
  const byPackage = new Map()
  for (const file of files) {
    const parts = file.relative.split("/")
    if (parts[0] === "scripts") { scriptFiles.push(file); continue }
    if (parts[0] === "test") { testFiles.push(file); continue }
    if (parts[0] === "packages" && parts.length > 2) {
      const directory = parts[1]
      const list = byPackage.get(directory) ?? []
      list.push(file)
      byPackage.set(directory, list)
      continue
    }
    if (/\.tgz$/.test(file.relative) || ["bun.lock", "package-lock.json"].includes(path.basename(file.relative))) continue
    rootFiles.push(file)
  }
  const packageSnapshots = packages.map((item) => {
    const directory = path.basename(item.directory)
    const all = byPackage.get(directory) ?? []
    const sourceFiles = all.filter((file) => !file.relative.includes("/test/"))
    return {
      name: item.manifest.name,
      directory,
      files: all,
      buildFiles: sourceFiles,
      sourceFiles,
      testFiles: all.filter((file) => file.relative.includes("/test/")),
    }
  })
  const hashes = (items) => digest(JSON.stringify(items.map((file) => [file.relative, file.hash])))
  const supportFiles = scriptFiles.filter((file) => !["scripts/workflow.mjs", "scripts/check-cache.mjs", "scripts/release.mjs", "scripts/publish.mjs"].includes(file.relative))
  return {
    root,
    packages: packageSnapshots,
    rootHash: hashes(rootFiles),
    scriptHash: hashes(scriptFiles),
    supportHash: hashes(supportFiles),
    lockHash: hashes(files.filter((file) => ["bun.lock", "bun.lockb", "package-lock.json", "pnpm-lock.yaml", "yarn.lock"].includes(path.basename(file.relative)))),
    helperHash: hashes(files.filter((file) => /(^|\/)test\//.test(file.relative) && !/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(file.relative))),
  }
}

export function packageHash(snapshot, directory, kind) {
  const item = snapshot.packages.find((entry) => entry.directory === directory)
  if (!item) return digest(`missing:${directory}`)
  const files = kind === "all" ? item.files : kind === "test" ? item.testFiles : kind === "source" ? item.sourceFiles : item.buildFiles
  return digest(JSON.stringify(files.map((file) => [file.relative, file.hash])))
}

export async function distHash(packageDirectory) {
  try {
    const files = await treeFiles(path.join(packageDirectory, "dist"))
    const entries = await Promise.all(files.map(async (file) => [path.relative(packageDirectory, file), createHash("sha256").update(await readFile(file)).digest("hex")]))
    return digest(JSON.stringify(entries.sort(([left], [right]) => String(left).localeCompare(String(right)))))
  } catch {
    return undefined
  }
}

export async function readMarker(cacheRoot, kind, key) {
  try {
    const value = JSON.parse(await readFile(path.join(cacheRoot, kind, `${key}.json`), "utf8"))
    return value.key === key ? value : undefined
  } catch {
    return undefined
  }
}

export async function writeMarker(cacheRoot, kind, key, value) {
  const directory = path.join(cacheRoot, kind)
  await mkdir(directory, { recursive: true })
  const file = path.join(directory, `${key}.json`)
  const temporary = `${file}.${process.pid}.tmp`
  await writeFile(temporary, JSON.stringify({ ...value, key, createdAt: new Date().toISOString() }), { mode: 0o600 })
  await rename(temporary, file)
}

export async function readTimings(cacheRoot, kind) {
  try {
    const value = JSON.parse(await readFile(path.join(cacheRoot, `${kind}-timings.json`), "utf8"))
    return value && typeof value === "object" ? value : {}
  } catch {
    return {}
  }
}

export async function writeTimings(cacheRoot, kind, timings) {
  try {
    const file = path.join(cacheRoot, `${kind}-timings.json`)
    const temporary = `${file}.${process.pid}.tmp`
    await writeFile(temporary, JSON.stringify(timings), { mode: 0o600 })
    await rename(temporary, file)
  } catch {}
}

export async function pruneCache(cacheRoot, limit = 2_000) {
  try {
    const entries = await readdir(cacheRoot, { withFileTypes: true })
    const markers = []
    for (const entry of entries) {
      const directory = path.join(cacheRoot, entry.name)
      if (entry.isFile() && entry.name.endsWith(".json")) {
        markers.push({ file: directory, at: (await stat(directory)).mtimeMs })
      } else if (entry.isDirectory()) {
        for (const file of await readdir(directory)) {
          if (!file.endsWith(".json")) continue
          const marker = path.join(directory, file)
          markers.push({ file: marker, at: (await stat(marker)).mtimeMs })
        }
      }
    }
    for (const item of markers.sort((left, right) => right.at - left.at).slice(limit)) await rm(item.file, { force: true })

    const pack = path.join(cacheRoot, "pack")
    for (const entry of await readdir(pack, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const marker = path.join(pack, `${entry.name}.json`)
      try {
        await stat(marker)
      } catch {
        const directory = path.join(pack, entry.name)
        if (Date.now() - (await stat(directory)).mtimeMs > 24 * 60 * 60 * 1000) await rm(directory, { recursive: true, force: true })
      }
    }
  } catch {}
}
