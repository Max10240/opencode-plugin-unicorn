import { expect, test } from "bun:test"
import os from "node:os"
import path from "node:path"
import { NoteStore, normalizeText, visibleNotes } from "../src/store.js"
import { MAX_NOTE_BYTES } from "../src/types.js"

function folder(name: string) {
  return path.resolve(os.tmpdir(), "opencode-notepad-test", name)
}

function createStore() {
  let data: unknown
  const store = new NoteStore(
    async () => data,
    async (value) => { data = value },
  )
  return { store, data: () => data }
}

test("folder notes stay in their folder and global notes are visible everywhere", async () => {
  const { store } = createStore()
  const a = folder("a")
  const b = folder("b")
  const local = await store.add({ text: "inside a", scope: "folder", directory: a })
  await Bun.sleep(2)
  const global = await store.add({ text: "everywhere", scope: "global", directory: a })

  expect((await store.list(a)).map((note) => note.id)).toEqual([global.id, local.id])
  expect((await store.list(b)).map((note) => note.id)).toEqual([global.id])
  expect(local.folder).toBe(a)
  expect(global.folder).toBeUndefined()
})

test("updates, scope changes, deletion, and ordering are durable", async () => {
  const { store, data } = createStore()
  const a = folder("a")
  const b = folder("b")
  const first = await store.add({ text: "first", scope: "folder", directory: a })
  await Bun.sleep(2)
  const second = await store.add({ text: "second", scope: "folder", directory: a })
  expect((await store.list(a)).map((note) => note.id)).toEqual([second.id, first.id])

  const updated = await store.update(first.id, "first edited")
  expect(updated.text).toBe("first edited")
  expect(updated.createdAt).toBe(first.createdAt)

  const moved = await store.setScope(first.id, "global", a)
  expect(moved.scope).toBe("global")
  expect(moved.folder).toBeUndefined()
  expect((await store.list(b)).map((note) => note.id)).toContain(first.id)

  const movedBack = await store.setScope(first.id, "folder", b)
  expect(movedBack.folder).toBe(b)
  expect((await store.list(a)).map((note) => note.id)).not.toContain(first.id)

  await store.remove(second.id)
  expect((await store.list(a)).map((note) => note.id)).toEqual([])
  expect(JSON.stringify(data())).not.toContain("second")
})

test("invalid input and corrupt storage fail without dropping valid notes", async () => {
  const { store } = createStore()
  await expect(store.add({ text: "   ", scope: "folder", directory: folder("a") })).rejects.toThrow("empty")
  await expect(store.add({ text: "x".repeat(MAX_NOTE_BYTES + 1), scope: "global" })).rejects.toThrow("exceeds")
  await expect(store.update("missing", "text")).rejects.toThrow("not found")
  await expect(store.remove("missing")).rejects.toThrow("not found")
  await expect(store.setScope("missing", "global", folder("a"))).rejects.toThrow("not found")

  const corrupt = new NoteStore(async () => ({ version: 1, notes: [{ bad: true }] }), async () => {})
  expect(await corrupt.list(folder("a"))).toEqual([])
  const invalid = new NoteStore(async () => ({ version: 99 }), async () => {})
  await expect(invalid.list(folder("a"))).rejects.toThrow("invalid")
})

test("normalization and visibility use resolved absolute paths", () => {
  expect(normalizeText("  hello\nworld  ")).toBe("hello\nworld")
  const directory = folder("a")
  expect(visibleNotes([
    { id: "1", text: "a", scope: "folder", folder: directory, createdAt: 1, updatedAt: 1 },
    { id: "2", text: "b", scope: "folder", folder: folder("b"), createdAt: 2, updatedAt: 2 },
    { id: "3", text: "c", scope: "global", createdAt: 3, updatedAt: 3 },
  ], path.join(directory, "..", "a")).map((note) => note.id)).toEqual(["3", "1"])
})
