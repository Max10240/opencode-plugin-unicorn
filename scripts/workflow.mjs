import { createHash } from "node:crypto"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { BUILD_MANIFEST, buildFingerprint, buildLevels, concurrency, mapLimit, treeFiles, workspacePackages } from "./workspace.mjs"
import { packWorkspace, verifyBuild } from "./test-artifacts.mjs"
import { runCommand, timed } from "./process.mjs"

const repository = fileURLToPath(new URL("../", import.meta.url))
export { BUILD_MANIFEST } from "./workspace.mjs"

export async function buildWorkspace(root, run = runCommand) {
  await run(["bun", "run", "check:versions"], { cwd: root })
  await run(["bun", "run", "sync:rules"], { cwd: root })
  for (const level of buildLevels(await workspacePackages(root))) {
    await mapLimit(level, concurrency, (item) => run(["bun", "run", "build"], { cwd: item.directory }))
  }
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

export async function executeWorkflow(mode, { root = repository, run = runCommand, fresh = false, pack = packWorkspace } = {}) {
  if (!["build", "typecheck", "test", "unit", "e2e", "packaged", "fast", "check"].includes(mode)) throw new Error(`Unknown workflow: ${mode}`)
  const started = performance.now()
  const environment = { ...process.env }
  delete environment[BUILD_MANIFEST]
  delete environment.UNICORN_TEST_FRESH_INSTALL
  if (mode === "build") return timed("build", () => buildWorkspace(root, run))
  const suites = await testSuites(root)
  const e2eFiles = suites.e2e.flat()
  const single = new Set([
    "opencode-plugin-notepad/test/tmux-e2e.test.ts",
    "opencode-plugin-prompt-search/test/tmux-e2e.test.ts",
    "opencode-plugin-send-message-across-sessions/test/tmux-e2e.test.ts",
    "opencode-plugin-sensitive-encrypt/test/tmux-e2e.test.ts",
  ])
  const isSingle = (file) => [...single].some((suffix) => file.endsWith(suffix))
  const wide = e2eFiles.filter((file) => !isSingle(file))
  const singleFiles = e2eFiles.filter(isSingle)
  const e2e = (files, fileLimit, testLimit) => mapLimit(files, fileLimit, (file) => run([
    "bun", "test", ...(testLimit > 1 ? ["--concurrent", `--max-concurrency=${testLimit}`] : []), "--timeout=60000", file,
  ], { cwd: root, env: environment }))
  const test = (kind) => timed(kind, () => {
    if (kind === "e2e") {
      return Promise.all([
        e2e(wide, Number(process.env.UNICORN_E2E_WIDE_FILES ?? 2), Number(process.env.UNICORN_E2E_WIDE_TESTS ?? 4)),
        e2e(singleFiles, Number(process.env.UNICORN_E2E_SINGLE_FILES ?? 4), 1),
      ])
    }
    return mapLimit(suites[kind], concurrency, (files) => run([
      "bun", "test", ...(kind === "render" ? ["--conditions=browser", "--preload", "@opentui/solid/preload"] : []), ...files,
    ], {
      cwd: kind === "render" ? path.dirname(path.dirname(files[0])) : root,
      env: kind === "packaged" && fresh ? { ...environment, UNICORN_TEST_FRESH_INSTALL: "1" } : environment,
    }))
  })
  if (mode === "unit") {
    await test("unit"); await test("render")
    console.log(`[check] total: ${((performance.now() - started) / 1000).toFixed(2)}s`)
    return
  }
  await timed("build", () => buildWorkspace(root, run))
  const temporary = await mkdtemp(path.join(os.tmpdir(), "unicorn-test-build-"))
  try {
    environment[BUILD_MANIFEST] = path.join(temporary, "build.json")
    const lease = { root, fingerprint: await buildFingerprint(root) }
    await writeFile(environment[BUILD_MANIFEST], JSON.stringify(lease), { mode: 0o600 })
    if (["test", "e2e", "packaged", "check"].includes(mode)) {
      const archives = await timed("pack", () => pack(path.join(temporary, "artifacts"), { root, run, env: environment }))
      lease.archives = await Promise.all(archives.map(async (item) => ({ ...item, digest: createHash("sha256").update(await readFile(item.file)).digest("hex") })))
      await writeFile(environment[BUILD_MANIFEST], JSON.stringify(lease))
    }
    const typecheck = async () => {
      const packages = await workspacePackages(root)
      return timed("typecheck", () => mapLimit(packages, concurrency, (item) => run(["bun", "run", "typecheck"], { cwd: item.directory, env: environment })))
    }
    if (mode === "check") {
      await Promise.all([typecheck(), test("unit"), test("render"), test("e2e"), test("packaged")])
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
      await test("packaged")
    }
    await verifyBuild(root, lease)
    return lease
  } finally {
    await rm(temporary, { recursive: true, force: true })
    console.log(`[check] total: ${((performance.now() - started) / 1000).toFixed(2)}s`)
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await executeWorkflow(process.argv[2] ?? "check", { fresh: process.argv.includes("--fresh") }) }
  catch (error) { console.error(error); process.exitCode = 1 }
}
