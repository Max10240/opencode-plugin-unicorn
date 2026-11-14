import { expect, test } from "bun:test"
import { mkdtemp, mkdir, readdir, rm, utimes, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { cleanupLeftovers, prune, update } from "../scripts/unicorn-shadow.mjs"

async function packageAt(root: string, name: string, dependencies: Record<string, string> = {}, peers: Record<string, string> = {}) {
  const directory = path.join(root, name)
  await mkdir(directory, { recursive: true })
  await writeFile(path.join(directory, "package.json"), JSON.stringify({ name, version: "1.0.0", dependencies, peerDependencies: peers }))
}

test("cleanupLeftovers removes only stale work and previous directories", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "opencode-shadow-leftovers-"))
  try {
    const directory = path.join(root, "unicorn-shadow")
    const staleWork = path.join(root, ".unicorn-shadow.work-stale")
    const stalePrevious = path.join(root, ".unicorn-shadow.previous-stale")
    const freshWork = path.join(root, ".unicorn-shadow.work-fresh")
    const unrelated = path.join(root, "unrelated")
    for (const target of [directory, staleWork, stalePrevious, freshWork, unrelated]) await mkdir(target, { recursive: true })
    await writeFile(path.join(directory, "snapshot.json"), "{}")
    const old = new Date(Date.now() - 2 * 60 * 60 * 1_000)
    await utimes(staleWork, old, old)
    await utimes(stalePrevious, old, old)

    expect((await cleanupLeftovers(directory)).sort()).toEqual([".unicorn-shadow.previous-stale", ".unicorn-shadow.work-stale"])
    for (const target of [freshWork, unrelated]) expect(await readdir(target)).toEqual([])
    for (const target of [staleWork, stalePrevious]) expect(await readdir(target).catch(() => undefined)).toBeUndefined()

    await rm(directory, { recursive: true, force: true })
    const rescue = path.join(root, ".unicorn-shadow.previous-rescue")
    await mkdir(rescue)
    await utimes(rescue, old, old)
    expect(await cleanupLeftovers(directory)).toEqual([])
    expect(await readdir(rescue)).toEqual([])
    await mkdir(directory)
    expect(await cleanupLeftovers(directory)).toEqual([".unicorn-shadow.previous-rescue"])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("prune keeps the runtime closure and removes host and unreachable packages", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "opencode-shadow-prune-"))
  try {
    const modules = path.join(root, "node_modules")
    await packageAt(modules, "@max10240/opencode-plugin-unicorn")
    await packageAt(modules, "@max10240/opencode-plugin-local", { "@opencode/plugin": "2.3.0", effect: "4.1.0" }, { "local-peer": "1.0.0" })
    await packageAt(modules, "local-peer")
    await packageAt(modules, "@opencode/ai", { "@opencode/schema": "2.3.0", effect: "4.1.0" })
    await packageAt(modules, "@opencode/schema", { effect: "4.1.0" })
    await packageAt(modules, "@opencode/plugin", { "@opencode/util": "2.3.0", effect: "4.1.0" })
    await packageAt(modules, "@opencode/util", { typescript: "5.8.2" })
    await packageAt(modules, "@opentui/core", { "web-tree-sitter": "0.25.0" })
    await packageAt(modules, "@opentui/solid", { "solid-js": "1.9.17" })
    await packageAt(modules, "solid-js")
    await packageAt(modules, "web-tree-sitter")
    await packageAt(modules, "effect")
    await packageAt(modules, "typescript")
    await packageAt(modules, "unreachable")
    await mkdir(path.join(modules, ".bin"), { recursive: true })

    const removed = await prune(modules, [
      { manifest: { name: "@max10240/opencode-plugin-unicorn" } },
      { manifest: { name: "@max10240/opencode-plugin-local", peerDependencies: { "local-peer": "1.0.0" } } },
    ])

    expect(removed.sort()).toEqual(["@opencode/plugin", "@opencode/util", "effect", "typescript", "unreachable"])
    for (const name of ["@max10240/opencode-plugin-unicorn", "@max10240/opencode-plugin-local", "@opencode/ai", "@opencode/schema", "@opentui/core", "@opentui/solid", "local-peer", "solid-js", "web-tree-sitter"]) {
      expect(await readdir(path.join(modules, name))).toEqual(["package.json"])
    }
    for (const name of ["@opencode/plugin", "@opencode/util", "effect", "typescript", "unreachable", ".bin"]) {
      expect(await readdir(path.join(modules, name)).catch(() => undefined)).toBeUndefined()
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("update refuses to replace a directory that is not a shadow snapshot", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "opencode-shadow-update-"))
  try {
    const directory = path.join(root, "occupied")
    await mkdir(directory, { recursive: true })
    await writeFile(path.join(directory, "keep.txt"), "keep")
    await expect(update(directory)).rejects.toThrow("snapshot.json is missing")
    expect(await readdir(directory)).toEqual(["keep.txt"])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
