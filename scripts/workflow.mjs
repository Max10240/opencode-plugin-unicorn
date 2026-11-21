import { createHash } from "node:crypto"
import { mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { CHECK_CACHE_VERSION, cacheKey, checkCacheDirectory, checkRuntime, distHash, packageHash, pruneCache, readMarker, readTimings, snapshotRepository, writeMarker, writeTimings } from "./check-cache.mjs"
import { BUILD_MANIFEST, buildFingerprint, buildLevels, concurrency, mapLimit, treeFiles, workspacePackages } from "./workspace.mjs"
import { packWorkspace, verifyBuild } from "./test-artifacts.mjs"
import { runCommand, timed } from "./process.mjs"

const repository = fileURLToPath(new URL("../", import.meta.url))
export { BUILD_MANIFEST } from "./workspace.mjs"

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

export async function executeWorkflow(mode, { root = repository, run = runCommand, fresh = false, pack = packWorkspace, cache = !fresh, cacheRoot = checkCacheDirectory() } = {}) {
  if (!["build", "typecheck", "test", "unit", "e2e", "packaged", "quick", "check"].includes(mode)) throw new Error(`Unknown workflow: ${mode}`)
  const started = performance.now()
  const environment = { ...process.env }
  delete environment[BUILD_MANIFEST]
  delete environment.UNICORN_TEST_FRESH_INSTALL
  if (mode === "build") return timed("build", () => buildWorkspace(root, run))
  const suites = await testSuites(root)
  const e2eFiles = suites.e2e.flat()
  const cacheEnabled = cache && !fresh
  await run(["bun", "run", "check:versions"], { cwd: root })
  await run(["bun", "run", "sync:rules"], { cwd: root })
  const packages = await workspacePackages(root)
  const packageByName = new Map(packages.map((item) => [item.manifest.name, item]))
  const snapshot = cacheEnabled || mode !== "build" ? await snapshotRepository(root, packages) : undefined
  const runtime = checkRuntime(environment)
  const tscVersion = await typescriptVersion(root, packages)
  await pruneCache(cacheRoot).catch(() => {})
  let distHashes = new Map()
  for (const item of packages) distHashes.set(item.manifest.name, await distHash(item.directory))

  const timings = cacheEnabled ? await readTimings(cacheRoot, "e2e") : {}
  const e2eStarted = performance.now()
  const e2e = (files, fileLimit, testLimit) => mapLimit(files, fileLimit, async (file) => {
    const limit = typeof testLimit === "function" ? testLimit(file) : testLimit
    const began = performance.now()
    if (process.env.UNICORN_CACHE_DEBUG) console.error(`[check] e2e start ${((began - e2eStarted) / 1000).toFixed(2)}s ${path.relative(root, file)} weight=${limit}`)
    await run([
      "bun", "test", ...(limit > 1 ? ["--concurrent", `--max-concurrency=${limit}`] : []), "--timeout=60000", file,
    ], { cwd: root, env: environment })
    const elapsed = (performance.now() - began) / 1000
    if (cacheEnabled) timings[path.relative(root, file)] = elapsed
    if (process.env.UNICORN_CACHE_DEBUG) console.error(`[check] e2e ${elapsed.toFixed(2)}s ${path.relative(root, file)} limit=${limit} at=${((performance.now() - e2eStarted) / 1000).toFixed(2)}s`)
  })

  const test = (kind) => timed(kind, async () => {
    if (kind === "e2e") {
      // Warm TUI shares one server and one pair of tmux sessions across tests, so its tests must
      // stay serial. It is scheduled first but only reserves one slot.
      const shared = (file) => file.endsWith("test/warm-tui-e2e.test.ts")
      const selected = e2eFiles
      if (selected.length === 0) return
      const testLimit = (file) => {
        if (shared(file)) return 1
        if (/opencode-plugin-delayed-queue[/\\]test[/\\](?:tui-)?e2e\.test\.ts$/.test(file)) return Number(process.env.UNICORN_E2E_DELAYED_TESTS ?? 4)
        if (/opencode-plugin-retry[/\\]test[/\\]tui-e2e\.test\.ts$/.test(file)) return Number(process.env.UNICORN_E2E_RETRY_TESTS ?? 4)
        if (/opencode-plugin-infinite-loop[/\\]test[/\\]e2e\.test\.ts$/.test(file)) return Number(process.env.UNICORN_E2E_LOOP_TESTS ?? 4)
        if (/opencode-plugin-infinite-loop[/\\]test[/\\]tui-e2e\.test\.ts$/.test(file)) return Number(process.env.UNICORN_E2E_LOOP_TUI_TESTS ?? 3)
        if (/opencode-plugin-image-gen[/\\]test[/\\]preview-e2e\.test\.ts$/.test(file)) return Number(process.env.UNICORN_E2E_PREVIEW_TESTS ?? 3)
        if (/opencode-plugin-image-gen[/\\]test[/\\]auth-e2e\.test\.ts$/.test(file)) return Number(process.env.UNICORN_E2E_AUTH_TESTS ?? 3)
        if (/test[/\\]version-lifecycle-e2e\.test\.ts$/.test(file)) return Number(process.env.UNICORN_E2E_LIFECYCLE_TESTS ?? 3)
        if (/test[/\\]rules-sync\.test\.ts$/.test(file)) return Number(process.env.UNICORN_E2E_RULES_TESTS ?? 4)
        if (/opencode-plugin-show-img[/\\]test[/\\]e2e\.test\.ts$/.test(file)) return Number(process.env.UNICORN_E2E_SHOW_TESTS ?? 2)
        if (/opencode-plugin-recomended-opencode-config[/\\]test[/\\]e2e\.test\.ts$/.test(file)) return Number(process.env.UNICORN_E2E_RECOMMENDED_TESTS ?? 4)
        if (/(?:auth)-e2e/.test(file)) return Number(process.env.UNICORN_E2E_HEAVY_TESTS ?? process.env.UNICORN_E2E_AUTH_TESTS ?? 3)
        return Number(process.env.UNICORN_E2E_WIDE_TESTS ?? 2)
      }
      // Start the files with the longest sequential work first. Ordering by the recorded wall time
      // is unstable because a loaded run inflates whichever files ran under contention; these
      // relative ranks only decide which files enter the first budget window.
      const priority = (file) => {
        if (shared(file)) return 10_000
        if (/opencode-plugin-delayed-queue[/\\]test[/\\]tui-e2e\.test\.ts$/.test(file)) return 900
        if (/opencode-plugin-infinite-loop[/\\]test[/\\]e2e\.test\.ts$/.test(file)) return 800
        if (/opencode-plugin-retry[/\\]test[/\\]tui-e2e\.test\.ts$/.test(file)) return 700
        if (/opencode-plugin-delayed-queue[/\\]test[/\\]e2e\.test\.ts$/.test(file)) return 600
        if (/opencode-plugin-image-gen[/\\]test[/\\]preview-e2e\.test\.ts$/.test(file)) return 500
        if (/opencode-plugin-recomended-opencode-config[/\\]test[/\\]e2e\.test\.ts$/.test(file)) return 400
        if (/test[/\\]rules-sync\.test\.ts$/.test(file)) return 300
        if (/opencode-plugin-send-message-across-sessions[/\\]test[/\\]cross-session-e2e\.test\.ts$/.test(file)) return 200
        if (/opencode-plugin-image-gen[/\\]test[/\\]auth-e2e\.test\.ts$/.test(file)) return 100
        return 0
      }
      const budget = Math.max(1, Number(process.env.UNICORN_E2E_BUDGET ?? 20))
      const jobs = selected
        .map((file) => {
          const limit = testLimit(file)
          const duration = timings[path.relative(root, file)] ?? 0
          return { file, limit, weight: Math.min(limit, budget), priority: priority(file), duration }
        })
        .sort((left, right) => right.priority - left.priority || right.duration - left.duration)
      const schedule = async (queue, limit) => {
        const pending = [...queue]
        let used = 0
        let failed = false
        let failure
        const active = new Set()
        await new Promise((resolve, reject) => {
          const pump = () => {
            while (!failed) {
              const index = pending.findIndex((job) => used + job.weight <= limit)
              if (index === -1) break
              const [job] = pending.splice(index, 1)
              used += job.weight
              const running = e2e([job.file], 1, job.limit).then(() => {}, (error) => {
                failed = true
                failure ??= error
              })
              active.add(running)
              running.finally(() => {
                used -= job.weight
                active.delete(running)
                pump()
              })
            }
            if (active.size === 0 && (failed || pending.length === 0)) {
              if (failure) reject(failure)
              else resolve()
            }
          }
          pump()
        })
      }
      await schedule(jobs, budget)
      if (cacheEnabled) await writeTimings(cacheRoot, "e2e", timings)
      return
    }
    const groups = suites[kind]
    await mapLimit(groups, concurrency, async (files) => {
      const cwd = kind === "render" ? path.dirname(path.dirname(files[0])) : root
      await run([
        "bun", "test", ...(kind === "render" ? ["--conditions=browser", "--preload", "@opentui/solid/preload"] : []), ...files,
      ], {
        cwd,
        env: kind === "packaged" && fresh ? { ...environment, UNICORN_TEST_FRESH_INSTALL: "1" } : environment,
      })
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
    const writeLease = async () => {
      const target = environment[BUILD_MANIFEST]
      const file = `${target}.${process.pid}.tmp`
      await writeFile(file, JSON.stringify(lease), { mode: 0o600 })
      await rename(file, target)
    }
    await writeLease()
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
    const packaged = async () => {
      await timed("packaged", async () => {
        const archives = await timed("pack", () => pack(path.join(temporary, "artifacts"), {
          root, run, env: environment, cache: cacheEnabled, cacheRoot, snapshot, distHashes,
        }))
        lease.archives = await Promise.all(archives.map(async (item) => ({ ...item, digest: createHash("sha256").update(await readFile(item.file)).digest("hex") })))
        await writeLease()
        await mapLimit(suites.packaged, concurrency, async (files) => {
          await run(["bun", "test", ...files], {
            cwd: root,
            env: {
              ...environment,
              ...(fresh ? { UNICORN_TEST_FRESH_INSTALL: "1" } : {}),
            },
          })
        })
      })
    }
    if (mode === "check") {
      if (fresh) {
        await typecheck()
        await test("unit")
        await test("render")
        await test("e2e")
        await packaged()
      } else {
        const results = await Promise.allSettled([typecheck(), test("unit"), test("render"), test("e2e"), packaged()])
        const failure = results.find((result) => result.status === "rejected")
        if (failure) throw failure.reason
      }
    } else if (mode === "typecheck") {
      await typecheck()
    } else if (mode === "test") {
      await test("unit")
      await test("render")
      await test("e2e")
    } else if (mode === "unit" || mode === "quick") {
      await test("unit")
      await test("render")
      if (mode === "quick") await typecheck()
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
    await executeWorkflow(mode, { fresh })
  }
  catch (error) { console.error(error); process.exitCode = 1 }
}
