import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { buildFingerprint, buildLevels, mapLimit } from "../scripts/workspace.mjs"
import { BUILD_MANIFEST, executeWorkflow, isTestFile, testGroup, testSuites } from "../scripts/workflow.mjs"
import { ensureBuilt, packWorkspace, verifyBuild } from "../scripts/test-artifacts.mjs"

async function fixture(run: (root: string) => Promise<void>) {
  const root = await mkdtemp(path.join(os.tmpdir(), "unicorn-workflow-test-"))
  try {
    await mkdir(path.join(root, "scripts"))
    await mkdir(path.join(root, "test"))
    await writeFile(path.join(root, "package.json"), "{}")
    for (const [name, dependencies] of [["a", {}], ["b", { a: "1.0.0" }]] as const) {
      const directory = path.join(root, "packages", name)
      await mkdir(path.join(directory, "dist"), { recursive: true })
      await mkdir(path.join(directory, "test", "tui"), { recursive: true })
      await writeFile(path.join(directory, "package.json"), JSON.stringify({ name, version: "1.0.0", dependencies, scripts: { build: "fixture", typecheck: "fixture", test: "fixture" } }))
      await writeFile(path.join(directory, "source.ts"), "source")
      await writeFile(path.join(directory, "dist", "index.js"), "export default 1")
      for (const file of ["unit.test.ts", "auth-e2e.test.ts", "tui/preview.test.tsx"]) await writeFile(path.join(directory, "test", file), "")
    }
    for (const file of ["versions.test.ts", "rules-sync.test.ts", "packaged-e2e.test.ts"]) await writeFile(path.join(root, "test", file), "")
    await run(root)
  } finally { await rm(root, { recursive: true, force: true }) }
}

test("test selection is disjoint and keeps all E2E and renderer conditions", () => {
  expect(testGroup("/repo/packages/a/test/auth-e2e.test.ts")).toBe("e2e")
  expect(testGroup("/repo/test/rules-sync.test.ts")).toBe("e2e")
  expect(testGroup("/repo/test/packaged-e2e.test.ts")).toBe("packaged")
  expect(testGroup("/repo/packages/a/test/tui/preview.test.tsx")).toBe("render")
  expect(testGroup("/repo/packages/a/test/model.test.ts")).toBe("unit")
  expect(testGroup("/repo/packages/a/test/e2e-environment.test.ts")).toBe("unit")
})

test("test discovery includes JS/spec files, ignores dependency fixtures, and fails on missing declared suites", async () => fixture(async (root) => {
  for (const name of ["example.test.js", "example.spec.ts", "example_test.tsx", "example.spec.mjs"]) expect(isTestFile(name)).toBe(true)
  expect(isTestFile("helper.ts")).toBe(false)
  const file = path.join(root, "test/example.spec.js")
  await writeFile(file, "")
  await mkdir(path.join(root, "test/node_modules"))
  await writeFile(path.join(root, "test/node_modules/ignored.test.ts"), "")
  const files = Object.values(await testSuites(root)).flat(2) as string[]
  expect(files).toContain(file)
  expect(files.some((name) => name.includes("node_modules"))).toBe(false)
  await rm(path.join(root, "packages/a/test"), { recursive: true })
  await expect(testSuites(root)).rejects.toThrow()
}))

test("build dependencies finish before dependents and cycles fail", () => {
  const item = (name: string, dependencies = {}) => ({ manifest: { name, dependencies } })
  expect(buildLevels([item("unicorn", { a: "1" }), item("a"), item("b")]).map((level: any[]) => level.map((entry) => entry.manifest.name))).toEqual([["a", "b"], ["unicorn"]])
  expect(() => buildLevels([item("a", { b: "1" }), item("b", { a: "1" })])).toThrow("cycle")
  expect(() => buildLevels([item("a"), item("a")])).toThrow("Duplicate")
})

test("bounded concurrency preserves result order and drains started jobs on failure", async () => {
  let active = 0
  let max = 0
  const values = await mapLimit([3, 2, 1], 2, async (value: number) => {
    active++; max = Math.max(max, active)
    await Bun.sleep(value)
    active--
    return value * 2
  })
  expect(values).toEqual([6, 4, 2])
  expect(max).toBe(2)
  const started: number[] = []
  await expect(mapLimit([1, 2, 3], 2, async (value: number) => {
    started.push(value)
    if (value === 1) throw new Error("failed")
    await Bun.sleep(5)
  })).rejects.toThrow("failed")
  expect(started).toEqual([1, 2])
  expect(active).toBe(0)
  let rejected = false
  try { await mapLimit([1], 1, async () => { throw undefined }) } catch { rejected = true }
  expect(rejected).toBe(true)
  await expect(mapLimit([], 0, async () => {})).rejects.toThrow("positive")
})

test("full check builds exactly once, runs every test once, and deletes the build lease", async () => fixture(async (root) => {
  const calls: Array<{ args: string[]; cwd: string; lease?: string }> = []
  let packs = 0
  await executeWorkflow("check", { root, pack: async () => { packs++; return [] }, run: async (args: string[], options: any) => {
    const lease = options.env?.[BUILD_MANIFEST]
    if (lease) expect(JSON.parse(await readFile(lease, "utf8")).root).toBe(root)
    calls.push({ args, cwd: options.cwd, lease })
    return ""
  } })
  expect(calls.filter((call) => call.args.join(" ") === "bun run build").map((call) => path.basename(call.cwd))).toEqual(["a", "b"])
  const tests = calls.filter((call) => call.args[1] === "test")
  const files = tests.flatMap((call) => call.args.filter((arg) => arg.endsWith(".test.ts") || arg.endsWith(".test.tsx")))
  expect(files).toHaveLength(9)
  expect(new Set(files).size).toBe(9)
  expect(packs).toBe(1)
  expect(tests.filter((call) => call.args.includes("--conditions=browser"))).toHaveLength(2)
  const lease = tests[0].lease!
  await expect(readFile(lease)).rejects.toThrow()
}))

test("fast and unit entrypoints never run server or packaged tests", async () => fixture(async (root) => {
  for (const mode of ["fast", "unit"]) {
    const calls: string[][] = []
    await executeWorkflow(mode, { root, run: async (args: string[]) => { calls.push(args); return "" } })
    const files = calls.flat().filter((arg) => arg.endsWith(".test.ts"))
    expect(files.some((file) => testGroup(file) !== "unit")).toBe(false)
    expect(calls.some((args) => args.join(" ") === "bun run build")).toBe(mode !== "unit")
  }
}))

test("a failed build prevents all checks and tests", async () => fixture(async (root) => {
  const calls: string[] = []
  await expect(executeWorkflow("check", { root, run: async (args: string[]) => {
    calls.push(args.join(" "))
    if (args[2] === "build") throw new Error("compile failed")
    return ""
  } })).rejects.toThrow("compile failed")
  expect(calls.some((call) => call.startsWith("bun test") || call.endsWith("typecheck"))).toBe(false)
}))

test("a source change during tests cannot produce a passing check and still cleans its lease", async () => fixture(async (root) => {
  let lease: string | undefined
  await expect(executeWorkflow("fast", { root, run: async (args: string[], options: any) => {
    if (args[1] === "test") {
      lease = options.env[BUILD_MANIFEST]
      await writeFile(path.join(root, "packages/a/source.ts"), "changed during tests")
    }
    return ""
  } })).rejects.toThrow("stale")
  expect(lease).toBeDefined()
  await expect(readFile(lease!)).rejects.toThrow()
}))

test("fresh-install flags apply only to packaged validation, not cache unit tests", async () => fixture(async (root) => {
  const tests: Array<{ files: string[]; fresh?: string }> = []
  await executeWorkflow("check", { root, fresh: true, pack: async () => [], run: async (args: string[], options: any) => {
    if (args[1] === "test") tests.push({ files: args, fresh: options.env.UNICORN_TEST_FRESH_INSTALL })
    return ""
  } })
  expect(tests.filter((item) => item.fresh === "1")).toHaveLength(1)
  expect(tests.find((item) => item.fresh === "1")!.files.some((file) => file.endsWith("packaged-e2e.test.ts"))).toBe(true)
}))

test("build leases invalidate on source, manifest, output changes or output deletion", async () => fixture(async (root) => {
  for (const target of [
    ...["source.ts", "package.json", "dist/index.js"].map((file) => path.join(root, "packages/a", file)),
    path.join(root, "test/versions.test.ts"),
  ]) {
    const original = await readFile(target)
    const lease = { root, fingerprint: await buildFingerprint(root) }
    await verifyBuild(root, lease)
    await writeFile(target, path.basename(target) === "package.json" ? '{"name":"a","version":"2.0.0"}' : "changed")
    await expect(verifyBuild(root, lease)).rejects.toThrow("stale")
    await writeFile(target, original)
  }
  const lease = { root, fingerprint: await buildFingerprint(root) }
  await rm(path.join(root, "packages/a/dist/index.js"))
  await expect(verifyBuild(root, lease)).rejects.toThrow()
}))

test("build fingerprints follow linked source files and reject directory cycles", async () => fixture(async (root) => {
  const source = path.join(root, "linked.ts")
  await writeFile(source, "first")
  await symlink(source, path.join(root, "packages/a/linked.ts"))
  const lease = { root, fingerprint: await buildFingerprint(root) }
  await writeFile(source, "second")
  await expect(verifyBuild(root, lease)).rejects.toThrow("stale")
  await symlink(path.join(root, "packages/a"), path.join(root, "packages/a/cycle"))
  await expect(buildFingerprint(root)).rejects.toThrow("cycle")
}))

test("standalone artifact preparation coalesces builds and never trusts an invalid lease", async () => fixture(async (root) => {
  let builds = 0
  const run = async () => { builds++; await Bun.sleep(5); return "" }
  await Promise.all([ensureBuilt(root, { env: {}, run }), ensureBuilt(root, { env: {}, run })])
  expect(builds).toBe(1)
  const file = path.join(root, "lease.json")
  await writeFile(file, JSON.stringify({ root, fingerprint: "wrong" }))
  await expect(ensureBuilt(root, { env: { [BUILD_MANIFEST]: file }, run })).rejects.toThrow("stale")
  expect(builds).toBe(1)
}))

test("packing skips lifecycle rebuilds only after validating the build lease", async () => fixture(async (root) => {
  const lease = path.join(root, "lease.json")
  await writeFile(lease, JSON.stringify({ root, fingerprint: await buildFingerprint(root) }))
  const destination = path.join(root, "archives")
  const calls: string[][] = []
  const archives = await packWorkspace(destination, { root, env: { [BUILD_MANIFEST]: lease }, run: async (args: string[], options: any) => {
    calls.push(args)
    const manifest = JSON.parse(await readFile(path.join(options.cwd, "package.json"), "utf8"))
    const filename = `${manifest.name}.tgz`
    await writeFile(path.join(destination, filename), manifest.name)
    return JSON.stringify([{ filename, version: manifest.version, files: [{ path: "dist/index.js" }] }])
  } })
  expect(archives).toHaveLength(2)
  expect(calls).toHaveLength(2)
  expect(calls.every((args) => args.includes("--ignore-scripts"))).toBe(true)
  await writeFile(path.join(root, "packages/a/source.ts"), "changed")
  await expect(packWorkspace(destination, { root, env: { [BUILD_MANIFEST]: lease }, run: async () => { throw new Error("must not pack") } })).rejects.toThrow("stale")
}))

test("cross-process archive leases copy current bytes and reject corruption without sharing writable files", async () => fixture(async (root) => {
  const directory = path.join(root, "packed")
  await mkdir(directory)
  const archives = await Promise.all(["a", "b"].map(async (name) => {
    const file = path.join(directory, `${name}.tgz`)
    await writeFile(file, name)
    return { file, directory: path.join(root, "packages", name), manifest: { name, version: "1.0.0" }, packed: {}, digest: createHash("sha256").update(name).digest("hex") }
  }))
  const lease = path.join(root, "lease.json")
  await writeFile(lease, JSON.stringify({ root, fingerprint: await buildFingerprint(root), archives }))
  const options = { root, env: { [BUILD_MANIFEST]: lease }, run: async () => { throw new Error("must not rebuild or repack") } }
  const copied = await packWorkspace(path.join(root, "copied"), options)
  expect(await readFile(copied[0].file, "utf8")).toBe("a")
  await writeFile(copied[0].file, "test-local mutation")
  expect(await readFile(archives[0].file, "utf8")).toBe("a")
  await writeFile(archives[0].file, "corrupt")
  await expect(packWorkspace(path.join(root, "next"), options)).rejects.toThrow("changed after packing")
}))
