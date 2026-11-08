import { expect, test } from "bun:test"
import { mkdir, mkdtemp, readdir, rm, utimes, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { cacheKey, distHash, packageHash, pruneCache, readMarker, snapshotRepository, writeMarker } from "../scripts/check-cache.mjs"

async function fixture(run: (root: string) => Promise<void>) {
  const root = await mkdtemp(path.join(os.tmpdir(), "unicorn-check-cache-"))
  try {
    await mkdir(path.join(root, "scripts"))
    await mkdir(path.join(root, "test"))
    await writeFile(path.join(root, "package.json"), "{}")
    await writeFile(path.join(root, "README.md"), "readme")
    for (const name of ["a", "b"]) {
      await mkdir(path.join(root, "packages", name, "src"), { recursive: true })
      await mkdir(path.join(root, "packages", name, "test"), { recursive: true })
      await mkdir(path.join(root, "packages", name, "dist"), { recursive: true })
      await writeFile(path.join(root, "packages", name, "package.json"), JSON.stringify({ name, version: "1.0.0", dependencies: name === "b" ? { a: "1.0.0" } : {} }))
      await writeFile(path.join(root, "packages", name, "src", "index.ts"), `export const value = "${name}"`)
      await writeFile(path.join(root, "packages", name, "test", "unit.test.ts"), "")
      await writeFile(path.join(root, "packages", name, "dist", "index.js"), "export default 1")
    }
    await writeFile(path.join(root, "test", "helper.ts"), "export {}")
    await writeFile(path.join(root, "scripts", "tool.mjs"), "export {}")
    await run(root)
  } finally { await rm(root, { recursive: true, force: true }) }
}

test("repository snapshots separate source, test and helper changes", async () => {
  await fixture(async (root) => {
    const packages = [
      { directory: path.join(root, "packages/a"), manifest: { name: "a", dependencies: {} } },
      { directory: path.join(root, "packages/b"), manifest: { name: "b", dependencies: { a: "1.0.0" } } },
    ]
    const first = await snapshotRepository(root, packages)
    const source = packageHash(first, "a", "source")
    const all = packageHash(first, "a", "all")

    await writeFile(path.join(root, "packages/a/src/index.ts"), "changed")
    const second = await snapshotRepository(root, packages)
    expect(packageHash(second, "a", "source")).not.toBe(source)
    expect(packageHash(second, "a", "all")).not.toBe(all)

    await writeFile(path.join(root, "packages/a/src/index.ts"), 'export const value = "a"')
    await writeFile(path.join(root, "packages/a/test/unit.test.ts"), "changed test")
    const third = await snapshotRepository(root, packages)
    expect(packageHash(third, "a", "source")).toBe(source)
    expect(packageHash(third, "a", "all")).not.toBe(all)

    await writeFile(path.join(root, "test/helper.ts"), "changed helper")
    const fourth = await snapshotRepository(root, packages)
    expect(fourth.helperHash).not.toBe(first.helperHash)
    expect(fourth.scriptHash).toBe(first.scriptHash)

    await writeFile(path.join(root, "scripts/tool.mjs"), "changed")
    const fifth = await snapshotRepository(root, packages)
    expect(fifth.scriptHash).not.toBe(first.scriptHash)
    expect(fifth.rootHash).toBe(first.rootHash)
  })
})

test("dist hashes follow output bytes", async () => {
  await fixture(async (root) => {
    const packages = [
      { directory: path.join(root, "packages/a"), manifest: { name: "a", dependencies: {} } },
      { directory: path.join(root, "packages/b"), manifest: { name: "b", dependencies: { a: "1.0.0", external: "^1" } } },
    ]
    const before = await distHash(path.join(root, "packages/a"))
    await writeFile(path.join(root, "packages/a/dist/index.js"), "changed")
    expect(await distHash(path.join(root, "packages/a"))).not.toBe(before)
  })
})

test("cache markers are keyed and missing markers stay misses", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "unicorn-cache-marker-"))
  try {
    const key = cacheKey(["x", 1])
    expect(await readMarker(root, "unit", key)).toBeUndefined()
    await writeMarker(root, "unit", key, { file: "test.ts" })
    expect(await readMarker(root, "unit", key)).toMatchObject({ file: "test.ts" })
    expect(await readMarker(root, "unit", cacheKey(["x", 2]))).toBeUndefined()
  } finally { await rm(root, { recursive: true, force: true }) }
})

test("cache pruning keeps recent markers and removes old orphaned archives", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "unicorn-cache-prune-"))
  try {
    const unit = path.join(root, "unit")
    await mkdir(unit)
    await writeFile(path.join(unit, "old.json"), "{}")
    await writeFile(path.join(unit, "new.json"), "{}")
    const old = new Date(Date.now() - 60_000)
    await utimes(path.join(unit, "old.json"), old, old)
    const orphan = path.join(root, "pack", "orphan")
    await mkdir(orphan, { recursive: true })
    await writeFile(path.join(orphan, "archive.tgz"), "archive")
    const stale = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000)
    await utimes(orphan, stale, stale)
    await pruneCache(root, 1)
    expect(await readdir(unit)).toEqual(["new.json"])
    expect(await readdir(path.join(root, "pack"))).toEqual([])
  } finally { await rm(root, { recursive: true, force: true }) }
})
