import { createHash } from "node:crypto"
import { execFileSync } from "node:child_process"
import { mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises"
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
    files,
    rootFiles,
    scriptFiles,
    testFiles,
    packages: packageSnapshots,
    rootHash: hashes(rootFiles),
    scriptHash: hashes(scriptFiles),
    supportHash: hashes(supportFiles),
    testHash: hashes(testFiles),
    lockHash: hashes(files.filter((file) => ["bun.lock", "bun.lockb", "package-lock.json", "pnpm-lock.yaml", "yarn.lock"].includes(path.basename(file.relative)))),
    manifestHash: hashes(files.filter((file) => path.basename(file.relative) === "package.json")),
    helperHash: hashes(files.filter((file) => /(^|\/)test\//.test(file.relative) && !/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(file.relative))),
  }
}

export function packageHash(snapshot, directory, kind) {
  const item = snapshot.packages.find((entry) => entry.directory === directory)
  if (!item) return digest(`missing:${directory}`)
  const files = kind === "all" ? item.files : kind === "test" ? item.testFiles : kind === "source" ? item.sourceFiles : item.buildFiles
  return digest(JSON.stringify(files.map((file) => [file.relative, file.hash])))
}

export function fileHash(snapshot, file) {
  const relative = path.relative(snapshot.root, file).split(path.sep).join("/")
  return snapshot.files.find((entry) => entry.relative === relative)?.hash ?? digest(`missing:${relative}`)
}

export function packageDirectory(file) {
  const parts = file.split(path.sep)
  const index = parts.lastIndexOf("packages")
  return index === -1 ? undefined : parts[index + 1]
}

const TEST_IMPORT = /(?:from\s*|import\s*(?:\(\s*)?|require\s*\(\s*)["'`]([^"'`]+)["'`]/g
const STRING_LITERAL = /["'`]([^"'`\n]+)["'`]/g
function packageNameFor(directory, packages) {
  const item = packages.find((entry) => path.basename(entry.directory) === directory)
  return item?.manifest.name
}

function packageForPath(file, packages) {
  const parts = file.split(path.sep)
  const index = parts.lastIndexOf("packages")
  if (index === -1 || index + 1 >= parts.length) return undefined
  const item = packages.find((entry) => path.basename(entry.directory) === parts[index + 1])
  if (!item) return undefined
  return { item, kind: parts.slice(index + 2).includes("test") ? "test" : "source" }
}

async function resolveFile(file, specifier) {
  if (!specifier.startsWith(".") && !specifier.startsWith("/")) return undefined
  const base = path.resolve(path.dirname(file), specifier)
  const rewritten = base.endsWith(".js") ? [base.slice(0, -3) + ".ts", base.slice(0, -3) + ".tsx"] : []
  const candidates = [base, ...rewritten, ...[".ts", ".tsx", ".js", ".mjs", ".json"].map((extension) => base + extension), ...["index.ts", "index.tsx", "index.js", "index.mjs"].map((name) => path.join(base, name))]
  for (const candidate of candidates) {
    try {
      if ((await stat(candidate)).isFile()) return candidate
    } catch {}
  }
  return undefined
}

async function resolvePath(file, value) {
  if (!value.startsWith(".") && !value.startsWith("/")) return undefined
  try {
    return await realpath(path.resolve(path.dirname(file), value))
  } catch {
    return undefined
  }
}

/**
 * Infers what a test can observe from its actual imports and path literals.
 * Everything is derived from source on every run, so there is no annotation to go stale.
 * Unicorn's own tests also depend on every child package; see workflow.mjs.
 */
export async function testDependencies(file, packages) {
  const kinds = new Map()
  const files = new Set()
  const add = (name, kind) => {
    if (!name) return
    const current = kinds.get(name)
    if (current === "all" || current === kind) return
    kinds.set(name, current === undefined ? kind : "all")
  }
  const own = packageForPath(file, packages)
  if (own) add(own.item.manifest.name, "all")
  const queue = [file]
  const visited = new Set()
  while (queue.length) {
    const current = queue.shift()
    if (visited.has(current)) continue
    visited.add(current)
    const text = await readFile(current, "utf8").catch(() => "")
    for (const match of text.matchAll(TEST_IMPORT)) {
      const specifier = match[1]
      const resolved = await resolveFile(current, specifier)
      if (resolved) {
        const dependency = packageForPath(resolved, packages)
        if (dependency) {
          if (dependency.kind === "test" && resolved !== file) {
            files.add(resolved)
            queue.push(resolved)
          } else add(dependency.item.manifest.name, "source")
        } else if (!resolved.includes(`${path.sep}node_modules${path.sep}`)) {
          files.add(resolved)
          queue.push(resolved)
        }
        continue
      }
      const bare = specifier.match(/(?:^|\/)(opencode-plugin-[a-z0-9-]+)(?:\/|$)/)
      if (bare) add(packageNameFor(bare[1], packages), "all")
    }
    if (current === file) {
      for (const match of text.matchAll(STRING_LITERAL)) {
        const value = match[1]
        if (value.includes("${") || path.basename(value) === "package.json") continue
        const resolved = await resolvePath(current, value)
        if (resolved) {
          const dependency = packageForPath(resolved, packages)
          if (dependency) {
            if (dependency.kind === "test") {
              files.add(resolved)
              queue.push(resolved)
            } else add(dependency.item.manifest.name, "source")
          }
        }
        for (const pathMatch of value.matchAll(/packages[\\/](opencode-plugin-[a-z0-9-]+)([^"'`\s]*)/g)) {
          const name = packageNameFor(pathMatch[1], packages)
          if (name && !pathMatch[2].startsWith("/package.json")) add(name, "source")
        }
      }
    }
  }
  return { packages: kinds, files: [...files].sort() }
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
