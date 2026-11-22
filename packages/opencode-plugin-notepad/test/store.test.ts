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

test("session notes stay in their session", async () => {
  const { store } = createStore()
  const directory = folder("session")
  const mine = await store.add({ text: "mine", scope: "session", directory, session: "session-a" })
  await Bun.sleep(2)
  const other = await store.add({ text: "other", scope: "session", directory, session: "session-b" })

  expect((await store.list(directory, "session-a")).map((note) => note.id)).toEqual([mine.id])
  expect((await store.list(directory, "session-b")).map((note) => note.id)).toEqual([other.id])
  expect(await store.list(directory)).toEqual([])
  expect(mine.session).toBe("session-a")

  await expect(store.add({ text: "missing session", scope: "session", directory })).rejects.toThrow("session")
  await expect(store.add({ text: "missing folder", scope: "folder" })).rejects.toThrow("folder")
})

test("pinned notes are created pinned and sorted first", async () => {
  const { store } = createStore()
  const a = folder("a")
  const pinned = await store.add({ text: "pinned", scope: "folder", directory: a, pinned: true })
  await Bun.sleep(2)
  const normal = await store.add({ text: "normal", scope: "folder", directory: a })
  expect(pinned.pinned).toBe(true)
  expect((await store.list(a)).map((note) => note.id)).toEqual([pinned.id, normal.id])
})

test("updates, deletion, and ordering are durable", async () => {
  const { store, data } = createStore()
  const a = folder("a")
  const first = await store.add({ text: "first", scope: "folder", directory: a })
  await Bun.sleep(2)
  const second = await store.add({ text: "second", scope: "folder", directory: a })
  expect((await store.list(a)).map((note) => note.id)).toEqual([second.id, first.id])

  const updated = await store.update(first.id, "first edited")
  expect(updated.text).toBe("first edited")
  expect(updated.createdAt).toBe(first.createdAt)
  expect(updated.scope).toBe("folder")
  expect(updated.folder).toBe(a)

  await store.remove(second.id)
  expect((await store.list(a)).map((note) => note.id)).toEqual([first.id])
  expect(JSON.stringify(data())).not.toContain("second")
})

test("invalid input and corrupt storage fail without dropping valid notes", async () => {
  const { store } = createStore()
  await expect(store.add({ text: "   ", scope: "folder", directory: folder("a") })).rejects.toThrow("empty")
  await expect(store.add({ text: "x".repeat(MAX_NOTE_BYTES + 1), scope: "global" })).rejects.toThrow("exceeds")
  await expect(store.update("missing", "text")).rejects.toThrow("not found")
  await expect(store.remove("missing")).rejects.toThrow("not found")

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
