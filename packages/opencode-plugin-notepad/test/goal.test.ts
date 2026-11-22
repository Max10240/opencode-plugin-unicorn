import { expect, test } from "bun:test"
import os from "node:os"
import path from "node:path"
import { GoalStore, goalInstruction, GOAL_INSTRUCTION_KEY } from "../src/goal.js"
import { MAX_GOAL_BYTES, type Note } from "../src/types.js"

function folder(name: string) {
  return path.resolve(os.tmpdir(), "opencode-notepad-goal-test", name)
}

function createGoals() {
  let data: unknown
  const store = new GoalStore(
    async () => data,
    async (value) => { data = value },
  )
  return { store, data: () => data }
}

function note(input: Partial<Note> & Pick<Note, "id" | "text" | "scope">): Note {
  return {
    id: input.id,
    text: input.text,
    scope: input.scope,
    ...(input.folder === undefined ? {} : { folder: input.folder }),
    ...(input.session === undefined ? {} : { session: input.session }),
    ...(input.pinned === true ? { pinned: true } : {}),
    createdAt: input.createdAt ?? 1,
    updatedAt: input.updatedAt ?? 1,
  }
}

test("accepts session and directory notes and rejects global or cross-context notes", async () => {
  const { store } = createGoals()
  const directory = folder("a")
  const session = note({ id: "session", text: "session note", scope: "session", session: "s1" })
  const local = note({ id: "local", text: "local note", scope: "folder", folder: directory })
  const global = note({ id: "global", text: "global note", scope: "global" })

  const sessionGoal = await store.set("s1", session, directory)
  expect(sessionGoal).toMatchObject({ noteID: "session", scope: "session", session: "s1" })
  const localGoal = await store.set("s1", local, directory)
  expect(localGoal).toMatchObject({ noteID: "local", scope: "folder", folder: directory })

  await expect(store.set("s1", global, directory)).rejects.toThrow("Global")
  await expect(store.set("s2", session, directory)).rejects.toThrow("another session")
  await expect(store.set("s1", note({ ...local, id: "other", folder: folder("b") }), directory)).rejects.toThrow("current directory")
  await expect(store.set("s1", note({ id: "long", text: "x".repeat(MAX_GOAL_BYTES + 1), scope: "folder", folder: directory }), directory)).rejects.toThrow("exceed")
})

test("editing a goal note updates the goal or clears it when too long", async () => {
  const { store } = createGoals()
  const directory = folder("a")
  const noteA = note({ id: "note-a", text: "old goal", scope: "folder", folder: directory })
  await store.set("s1", noteA, directory)
  await store.set("s2", noteA, directory)

  const updated = await store.updateNote(note({ ...noteA, text: "new goal", updatedAt: 5 }))
  expect(updated.cleared).toEqual([])
  expect(updated.updated.map((entry) => entry.sessionID).sort()).toEqual(["s1", "s2"])
  expect((await store.get("s1"))?.text).toBe("new goal")
  expect((await store.get("s2"))?.text).toBe("new goal")

  const cleared = await store.updateNote(note({ ...noteA, text: "x".repeat(MAX_GOAL_BYTES + 1), updatedAt: 6 }))
  expect(cleared.cleared.sort()).toEqual(["s1", "s2"])
  expect(await store.get("s1")).toBeUndefined()
  expect(await store.get("s2")).toBeUndefined()
})

test("deleting a goal note clears every session that referenced it", async () => {
  const { store } = createGoals()
  const directory = folder("a")
  const noteA = note({ id: "note-a", text: "goal", scope: "folder", folder: directory })
  await store.set("s1", noteA, directory)
  await store.set("s2", noteA, directory)
  await store.set("s3", note({ ...noteA, id: "note-b" }), directory)

  expect((await store.removeNote("note-a")).sort()).toEqual(["s1", "s2"])
  expect(await store.get("s1")).toBeUndefined()
  expect(await store.get("s2")).toBeUndefined()
  expect((await store.get("s3"))?.noteID).toBe("note-b")
})

test("goal storage is versioned and uses the instruction key", async () => {
  const { store, data } = createGoals()
  const directory = folder("a")
  await store.set("s1", note({ id: "note", text: "goal", scope: "folder", folder: directory }), directory)
  expect(data()).toMatchObject({ version: 1, goals: { s1: { noteID: "note" } } })
  expect(GOAL_INSTRUCTION_KEY).toBe("notepad.goal")
  expect(goalInstruction("ship it")).toContain("ship it")

  const invalid = new GoalStore(async () => ({ version: 99 }), async () => {})
  await expect(invalid.get("s1")).rejects.toThrow("invalid")
})
