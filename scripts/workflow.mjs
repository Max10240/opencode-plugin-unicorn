import { createHash } from "node:crypto"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { CHECK_CACHE_VERSION, cacheKey, checkCacheDirectory, checkRuntime, distHash, fileHash, packageDirectory, packageHash, pruneCache, readMarker, readTimings, snapshotRepository, testDependencies, writeMarker, writeTimings } from "./check-cache.mjs"
import { BUILD_MANIFEST, buildFingerprint, buildLevels, concurrency, mapLimit, treeFiles, workspacePackages } from "./workspace.mjs"
import { packWorkspace, verifyBuild } from "./test-artifacts.mjs"
import { runCommand, timed } from "./process.mjs"

const repository = fileURLToPath(new URL("../", import.meta.url))
export { BUILD_MANIFEST } from "./workspace.mjs"

export const FRESH_ONLY = new Set([
  "opencode-plugin-notepad/test/tmux-e2e.test.ts",
  "opencode-plugin-prompt-search/test/tmux-e2e.test.ts",
  "opencode-plugin-send-message-across-sessions/test/tmux-e2e.test.ts",
  "opencode-plugin-sensitive-encrypt/test/tmux-e2e.test.ts",
  "opencode-plugin-image-gen/test/preview-e2e.test.ts",
  "opencode-plugin-session-search/test/e2e.test.ts",
  "opencode-plugin-show-img/test/e2e.test.ts",
  "test/rules-sync.test.ts",
])

async function typescriptVersion(root, packages) {
  for (const directory of [root, ...packages.map((item) => item.directory)]) {
    try {
      const manifest = JSON.parse(await readFile(path.join(directory, "node_modules", "typescript", "package.json"), "utf8"))
      if (typeof manifest.version === "string") return manifest.version
    } catch {}
  }
  return "unavailable"
}

export async function buildWorkspace(root, run = runCommand, { cache = false, snapshot, cacheRoot, environment = process.env, tscVersion = "unavailable", prepared = false } = {}) {
  if (!prepared) {
    await run(["bun", "run", "check:versions"], { cwd: root })
    await run(["bun", "run", "sync:rules"], { cwd: root })
  }
  const packages = await workspacePackages(root)
  const byName = new Map(packages.map((item) => [item.manifest.name, item]))
  const distHashes = new Map()
  const runtime = checkRuntime(environment)
  for (const level of buildLevels(packages)) {
    await mapLimit(level, concurrency, async (item) => {
      const name = item.manifest.name
      const dependencies = Object.keys({ ...item.manifest.dependencies, ...item.manifest.optionalDependencies }).filter((value) => byName.has(value))
      let key
      if (cache && snapshot) {
        key = cacheKey([
          CHECK_CACHE_VERSION, "build", snapshot.root, snapshot.lockHash, packageHash(snapshot, path.basename(item.directory), "build"),
          dependencies.map((dependency) => [dependency, distHashes.get(dependency)]), runtime.bun, tscVersion,
        ])
        const stored = await readMarker(cacheRoot, "build", key)
        const current = await distHash(item.directory)
        if (stored?.distHash && current && stored.distHash === current) {
          distHashes.set(name, current)
          return
        }
      }
      if (process.env.UNICORN_CACHE_DEBUG && cache) console.error(`[check] build rerun: ${name}`)
      await run(["bun", "run", "build"], { cwd: item.directory })
      const current = await distHash(item.directory)
      distHashes.set(name, current)
      if (key) await writeMarker(cacheRoot, "build", key, { distHash: current })
    })
  }
  return { packages, distHashes }
}

export function testGroup(file) {
  if (/[/\\]test[/\\]tui[/\\]/.test(file)) return "render"
  if (path.basename(file) === "e2e-environment.test.ts") return "unit"
  if (path.basename(file) === "packaged-e2e.test.ts") return "packaged"
  if (path.basename(file) === "rules-sync.test.ts" || /(?:^|[-/\\])e2e(?:[-.]|$)/.test(file)) return "e2e"
  return "unit"
}

export function isTestFile(file) {
  return /[._](?:test|spec)\.[cm]?[jt]sx?$/.test(file)
}

export async function testSuites(root) {
  const directories = [path.join(root, "test"), ...(await workspacePackages(root)).filter((item) => item.manifest.scripts?.test).map((item) => path.join(item.directory, "test"))]
  const groups = { unit: [], e2e: [], render: [], packaged: [] }
  for (const directory of directories) {
    const files = (await treeFiles(directory, new Set(["node_modules", "dist", "coverage"]))).filter(isTestFile)
    for (const kind of Object.keys(groups)) {
      const selected = files.filter((file) => testGroup(file) === kind)
      if (selected.length) groups[kind].push(selected)
    }
  }
  return groups
}

export async function executeWorkflow(mode, { root = repository, run = runCommand, fresh = false, all = false, pack = packWorkspace, cache = !fresh, cacheRoot = checkCacheDirectory(), skipPackaged = false } = {}) {
  if (!["build", "typecheck", "test", "unit", "e2e", "packaged", "fast", "check"].includes(mode)) throw new Error(`Unknown workflow: ${mode}`)
  const started = performance.now()
  const environment = { ...process.env }
  delete environment[BUILD_MANIFEST]
  delete environment.UNICORN_TEST_FRESH_INSTALL
  if (mode === "build") return timed("build", () => buildWorkspace(root, run))
  const suites = await testSuites(root)
  const freshOnly = FRESH_ONLY
  const e2eFiles = (mode === "check" && !fresh && !all ? suites.e2e.flat().filter((file) => ![...freshOnly].some((suffix) => file.endsWith(suffix))) : suites.e2e.flat())
  const cacheEnabled = cache && !fresh
  await run(["bun", "run", "check:versions"], { cwd: root })
  await run(["bun", "run", "sync:rules"], { cwd: root })
  const packages = await workspacePackages(root)
  const packageByName = new Map(packages.map((item) => [item.manifest.name, item]))
  const packageByDirectory = new Map(packages.map((item) => [path.basename(item.directory), item]))
  const snapshot = cacheEnabled || mode !== "build" ? await snapshotRepository(root, packages) : undefined
  const runtime = checkRuntime(environment)
  const tscVersion = await typescriptVersion(root, packages)
  await pruneCache(cacheRoot).catch(() => {})
  let distHashes = new Map()
  for (const item of packages) distHashes.set(item.manifest.name, await distHash(item.directory))

  const testKey = async (kind, file) => {
    const directory = packageDirectory(file)
    const pkg = directory ? packageByDirectory.get(directory) : undefined
    const text = await readFile(file, "utf8").catch(() => "")
    const dependencies = await testDependencies(file, packages)
    const kinds = dependencies.packages
    const unicorn = "@max10240/opencode-plugin-unicorn"
    if (pkg?.manifest.name === unicorn) for (const item of packages) kinds.set(item.manifest.name, "all")
    const sources = [...kinds].sort(([left], [right]) => left.localeCompare(right)).map(([name, kind]) => {
      const item = packageByName.get(name)
      return [name, item ? packageHash(snapshot, path.basename(item.directory), kind) : undefined, distHashes.get(name)]
    })
    const helpers = dependencies.files.map((dependency) => {
      const relative = path.relative(root, dependency).split(path.sep).join("/")
      return [relative, fileHash(snapshot, dependency)]
    })
    const scripts = !pkg ? snapshot.scriptHash : text.includes("scripts/") ? snapshot.supportHash : undefined
    return cacheKey([
      CHECK_CACHE_VERSION, kind, snapshot.root, snapshot.lockHash, fileHash(snapshot, file), snapshot.manifestHash,
      pkg ? undefined : [snapshot.rootHash, snapshot.testHash], scripts, sources, helpers, snapshot.helperHash, runtime,
      { opencodeBin: environment.OPENCODE_BIN, logLevel: environment.OPENCODE_E2E_LOG_LEVEL },
    ])
  }

  const cachedFiles = async (kind, files) => {
    if (!cacheEnabled) return { files, keys: new Map() }
    const entries = await Promise.all(files.map(async (file) => [file, await testKey(kind, file)]))
    const keys = new Map(entries)
    const uncached = []
    for (const [file, key] of entries) if (!(await readMarker(cacheRoot, kind, key))) uncached.push(file)
    if (process.env.UNICORN_CACHE_DEBUG && uncached.length) console.error(`[check] ${kind} rerun: ${uncached.map((file) => `${path.relative(root, file)} ${keys.get(file)}`).join(", ")}`)
    return { files: uncached, keys }
  }

  const recordFiles = async (kind, files, keys) => {
    if (!cacheEnabled) return
    for (const file of files) await writeMarker(cacheRoot, kind, keys.get(file), { file })
  }

  const timings = cacheEnabled ? await readTimings(cacheRoot, "e2e") : {}
  const e2e = (files, fileLimit, testLimit, keys) => mapLimit(files, fileLimit, async (file) => {
    const limit = typeof testLimit === "function" ? testLimit(file) : testLimit
    const began = performance.now()
    await run([
      "bun", "test", ...(limit > 1 ? ["--concurrent", `--max-concurrency=${limit}`] : []), "--timeout=60000", file,
    ], { cwd: root, env: environment })
    const elapsed = (performance.now() - began) / 1000
    if (cacheEnabled) timings[path.relative(root, file)] = elapsed
    if (process.env.UNICORN_CACHE_DEBUG) console.error(`[check] e2e ${elapsed.toFixed(2)}s ${path.relative(root, file)} limit=${limit}`)
    await recordFiles("e2e", [file], keys)
  })

  const test = (kind) => timed(kind, async () => {
    if (kind === "e2e") {
      const single = new Set([
        "opencode-plugin-notepad/test/tmux-e2e.test.ts",
        "opencode-plugin-prompt-search/test/tmux-e2e.test.ts",
        "opencode-plugin-send-message-across-sessions/test/tmux-e2e.test.ts",
        "opencode-plugin-sensitive-encrypt/test/tmux-e2e.test.ts",
      ])
      const isSingle = (file) => [...single].some((suffix) => file.endsWith(suffix))
      const selected = await cachedFiles("e2e", e2eFiles)
      if (selected.files.length === 0) return
      const ordered = [...selected.files].sort((left, right) => (timings[path.relative(root, right)] ?? 0) - (timings[path.relative(root, left)] ?? 0))
      const wide = ordered.filter((file) => !isSingle(file))
      const singleFiles = ordered.filter(isSingle)
      const small = selected.files.length <= 6
      const testLimit = (file) => /(?:auth|preview)-e2e/.test(file) ? 8 : small ? 4 : Number(process.env.UNICORN_E2E_WIDE_TESTS ?? 4)
      await Promise.all([
        e2e(wide, small ? Math.max(1, Math.min(7, wide.length)) : Number(process.env.UNICORN_E2E_WIDE_FILES ?? 2), testLimit, selected.keys),
        e2e(singleFiles, small ? Math.max(1, Math.min(4, singleFiles.length)) : Number(process.env.UNICORN_E2E_SINGLE_FILES ?? 4), 1, selected.keys),
      ])
      if (cacheEnabled) await writeTimings(cacheRoot, "e2e", timings)
      return
    }
    const groups = []
    for (const files of suites[kind]) {
      const selected = await cachedFiles(kind, files)
      if (selected.files.length) groups.push(selected)
    }
    await mapLimit(groups, concurrency, async (selected) => {
      const cwd = kind === "render" ? path.dirname(path.dirname(selected.files[0])) : root
      await run([
        "bun", "test", ...(kind === "render" ? ["--conditions=browser", "--preload", "@opentui/solid/preload"] : []), ...selected.files,
      ], {
        cwd,
        env: kind === "packaged" && fresh ? { ...environment, UNICORN_TEST_FRESH_INSTALL: "1" } : environment,
      })
      if (kind !== "packaged") await recordFiles(kind, selected.files, selected.keys)
    })
  })

  if (mode === "unit") {
    await test("unit"); await test("render")
    console.log(`[check] total: ${((performance.now() - started) / 1000).toFixed(2)}s`)
    return
  }

  const built = await timed("build", () => buildWorkspace(root, run, { cache: cacheEnabled, snapshot, cacheRoot, environment, tscVersion, prepared: true }))
  distHashes = built.distHashes
  const temporary = await mkdtemp(path.join(os.tmpdir(), "unicorn-test-build-"))
  try {
    environment[BUILD_MANIFEST] = path.join(temporary, "build.json")
    const lease = { root, fingerprint: await buildFingerprint(root) }
    await writeFile(environment[BUILD_MANIFEST], JSON.stringify(lease), { mode: 0o600 })
    const typecheck = async () => {
      if (!cacheEnabled) {
        return timed("typecheck", () => mapLimit(packages, concurrency, (item) => run(["bun", "run", "typecheck"], { cwd: item.directory, env: environment })))
      }
      const pending = []
      for (const item of packages) {
        const dependencies = Object.keys({ ...item.manifest.dependencies, ...item.manifest.optionalDependencies }).filter((name) => packageByName.has(name))
        const key = cacheKey([
          CHECK_CACHE_VERSION, "typecheck", snapshot.root, snapshot.lockHash, packageHash(snapshot, path.basename(item.directory), "all"),
          dependencies.map((name) => [name, packageHash(snapshot, path.basename(packageByName.get(name).directory), "source"), distHashes.get(name)]), runtime.bun, tscVersion,
        ])
        if (await readMarker(cacheRoot, "typecheck", key)) continue
        pending.push({ item, key })
      }
      if (pending.length === 0) return timed("typecheck", async () => {})
      return timed("typecheck", () => mapLimit(pending, concurrency, async ({ item, key }) => {
        await run(["bun", "run", "typecheck"], { cwd: item.directory, env: environment })
        await writeMarker(cacheRoot, "typecheck", key, { directory: item.directory })
      }))
    }
    const packagedKey = cacheKey([
      CHECK_CACHE_VERSION, "packaged", snapshot.root, snapshot.lockHash, snapshot.rootHash,
      packages.map((item) => [item.manifest.name, packageHash(snapshot, path.basename(item.directory), "build"), distHashes.get(item.manifest.name)]),
      snapshot.helperHash, snapshot.supportHash, snapshot.scriptHash, fileHash(snapshot, path.join(root, "test/packaged-e2e.test.ts")), runtime,
      { opencodeBin: environment.OPENCODE_BIN },
    ])
    const packagedCached = skipPackaged || (cacheEnabled && mode !== "packaged" && Boolean(await readMarker(cacheRoot, "packaged", packagedKey)))
    const packaged = async () => {
      if (packagedCached) return
      await timed("packaged", async () => {
        const archives = await timed("pack", () => pack(path.join(temporary, "artifacts"), {
          root, run, env: environment, cache: cacheEnabled, cacheRoot, snapshot, distHashes,
        }))
        lease.archives = await Promise.all(archives.map(async (item) => ({ ...item, digest: createHash("sha256").update(await readFile(item.file)).digest("hex") })))
        await writeFile(environment[BUILD_MANIFEST], JSON.stringify(lease))
        await mapLimit(suites.packaged, concurrency, async (files) => {
          await run(["bun", "test", ...files], {
            cwd: root,
            env: {
              ...environment,
              ...(fresh ? { UNICORN_TEST_FRESH_INSTALL: "1" } : {}),
            },
          })
        })
        if (cacheEnabled) await writeMarker(cacheRoot, "packaged", packagedKey, { directory: root })
      })
    }
    if (mode === "check") {
      await Promise.all([typecheck(), test("unit"), test("render"), test("e2e"), packaged()])
    } else if (mode === "typecheck") {
      await typecheck()
    } else if (mode === "test") {
      await test("unit")
      await test("render")
      await test("e2e")
    } else if (mode === "unit" || mode === "fast") {
      await test("unit")
      await test("render")
      if (mode === "fast") await typecheck()
    } else if (mode === "e2e") {
      await test("e2e")
    } else if (mode === "packaged") {
      await packaged()
    }
    await verifyBuild(root, lease)
    return lease
  } finally {
    await rm(temporary, { recursive: true, force: true })
    console.log(`[check] total: ${((performance.now() - started) / 1000).toFixed(2)}s`)
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const mode = process.argv[2] ?? "check"
    const fresh = process.argv.includes("--fresh")
    const all = process.argv.includes("--all")
    await executeWorkflow(mode, { fresh, all, skipPackaged: mode === "check" })
  }
  catch (error) { console.error(error); process.exitCode = 1 }
}
