import { expect, test } from "bun:test"
import os from "node:os"
import path from "node:path"
import { setupNotepad } from "../src/index.js"
import { GOAL_INSTRUCTION_KEY } from "../src/goal.js"
import { MAX_GOAL_BYTES } from "../src/types.js"

function folder(name: string) {
  return path.resolve(os.tmpdir(), "opencode-notepad-goal-rpc-test", name)
}

async function createHarness() {
  const stored: Record<string, unknown> = {}
  const puts: Array<{ sessionID: string; key: string; value: unknown }> = []
  const removes: Array<{ sessionID: string; key: string }> = []
  const methods: Record<string, (...args: any[]) => Promise<any>> = {}
  let deletedListener: ((sessionID: string) => void) | undefined
  const context = {
    options: {},
    storage: {
      get: async (key: string) => stored[key],
      set: async (key: string, value: unknown) => { stored[key] = value },
    },
    rpc: {
      register: async (_definition: unknown, handlers: Record<string, (...args: any[]) => Promise<any>>) => {
        Object.assign(methods, handlers)
        return { dispose: async () => {} }
      },
    },
    session: {
      instructions: {
        entry: {
          put: async (input: { sessionID: string; key: string; value: unknown }) => { puts.push(input) },
          remove: async (input: { sessionID: string; key: string }) => { removes.push(input) },
        },
      },
    },
    event: {
      subscribe: async function* ({ signal }: { signal?: AbortSignal }) {
        while (!signal?.aborted) {
          const sessionID = await new Promise<string | undefined>((resolve) => {
            deletedListener = resolve
            signal?.addEventListener("abort", () => resolve(undefined), { once: true })
          })
          if (sessionID === undefined) return
          yield { type: "session.deleted", data: { sessionID } }
        }
      },
    },
  } as any
  const dispose = await setupNotepad(context)
  const request = {
    error: (_tag: string, message: string) => {
      throw new Error(message)
    },
  }
  const call = (name: string, input: unknown) => methods[name]!(input, request)
  const setStored = (key: string, value: unknown) => { stored[key] = value }
  const deleteSession = (sessionID: string) => { deletedListener?.(sessionID) }
  return { dispose, puts, removes, methods, call, setStored, deleteSession }
}

test("setting a goal writes the session instruction and listing returns it", async () => {
  const harness = await createHarness()
  try {
    const directory = folder("a")
    const added = await harness.call("add", { text: "Goal note", scope: "session", directory, session: "s1" })
    const note = added.note

    const result = await harness.call("setGoal", { sessionID: "s1", noteID: note.id, directory })
    expect(result.goal).toMatchObject({ noteID: note.id, text: "Goal note", scope: "session", session: "s1" })
    expect(harness.puts).toHaveLength(1)
    expect(harness.puts[0]).toMatchObject({ sessionID: "s1", key: GOAL_INSTRUCTION_KEY })
    expect(harness.puts[0]?.value).toContain("Goal note")

    const listed = await harness.call("list", { directory, session: "s1" })
    expect(listed.notes).toHaveLength(1)
    expect(listed.goal).toMatchObject({ noteID: note.id, text: "Goal note" })
    expect(harness.methods.setScope).toBeUndefined()

    const cleared = await harness.call("clearGoal", { sessionID: "s1" })
    expect(cleared.cleared).toBe(true)
    expect(harness.removes).toHaveLength(1)
    expect(harness.removes[0]).toMatchObject({ sessionID: "s1", key: GOAL_INSTRUCTION_KEY })
    expect((await harness.call("list", { directory, session: "s1" })).goal).toBeUndefined()
  } finally {
    await harness.dispose()
  }
})

test("goal updates follow note edits and oversized edits clear the goal", async () => {
  const harness = await createHarness()
  try {
    const directory = folder("a")
    const added = await harness.call("add", { text: "Goal note", scope: "folder", directory, session: "s1" })
    const note = added.note
    await harness.call("setGoal", { sessionID: "s1", noteID: note.id, directory })

    const updated = await harness.call("update", { id: note.id, text: "Updated goal" })
    expect(updated.goalCleared).toBeUndefined()
    expect(harness.puts.at(-1)?.value).toContain("Updated goal")
    expect((await harness.call("list", { directory, session: "s1" })).goal.text).toBe("Updated goal")

    const oversized = await harness.call("update", { id: note.id, text: "x".repeat(MAX_GOAL_BYTES + 1) })
    expect(oversized.goalCleared).toBe(true)
    expect(harness.removes.at(-1)).toMatchObject({ sessionID: "s1", key: GOAL_INSTRUCTION_KEY })
    expect((await harness.call("list", { directory, session: "s1" })).goal).toBeUndefined()
  } finally {
    await harness.dispose()
  }
})

test("global notes and notes from another directory cannot become goals", async () => {
  const harness = await createHarness()
  try {
    const directory = folder("a")
    const global = (await harness.call("add", { text: "Global", scope: "global", directory })).note
    const local = (await harness.call("add", { text: "Local", scope: "folder", directory })).note
    const other = (await harness.call("add", { text: "Other", scope: "folder", directory: folder("b") })).note

    await expect(harness.call("setGoal", { sessionID: "s1", noteID: global.id, directory })).rejects.toThrow("Global")
    await expect(harness.call("setGoal", { sessionID: "s1", noteID: local.id, directory: folder("b") })).rejects.toThrow("not found")
    await expect(harness.call("setGoal", { sessionID: "s2", noteID: other.id, directory })).rejects.toThrow("not found")
    expect(harness.puts).toHaveLength(0)
  } finally {
    await harness.dispose()
  }
})

test("note edits and removal survive corrupt goal metadata", async () => {
  const harness = await createHarness()
  try {
    const directory = folder("a")
    const note = (await harness.call("add", { text: "Goal note", scope: "session", directory, session: "s1" })).note
    await harness.call("setGoal", { sessionID: "s1", noteID: note.id, directory })
    harness.setStored("goals", { version: 99 })

    const updated = await harness.call("update", { id: note.id, text: "Still saved" })
    expect(updated.note.text).toBe("Still saved")
    await harness.call("remove", { id: note.id })
    expect((await harness.call("list", { directory, session: "s1" })).notes).toEqual([])
  } finally {
    await harness.dispose()
  }
})

test("deleting a session clears its goal so the note can be removed", async () => {
  const harness = await createHarness()
  try {
    const directory = folder("a")
    const note = (await harness.call("add", { text: "Goal note", scope: "session", directory, session: "s1" })).note
    await harness.call("setGoal", { sessionID: "s1", noteID: note.id, directory })

    harness.deleteSession("s1")
    const deadline = Date.now() + 2_000
    while (Date.now() < deadline) {
      if ((await harness.call("list", { directory, session: "s1" })).goal === undefined) break
      await Bun.sleep(10)
    }
    expect((await harness.call("list", { directory, session: "s1" })).goal).toBeUndefined()
    expect(harness.removes.at(-1)).toMatchObject({ sessionID: "s1", key: GOAL_INSTRUCTION_KEY })
    expect((await harness.call("remove", { id: note.id })).removed).toBe(true)
  } finally {
    await harness.dispose()
  }
})

test("removing a goal note is rejected until the goal is cleared", async () => {
  const harness = await createHarness()
  try {
    const directory = folder("a")
    const note = (await harness.call("add", { text: "Goal note", scope: "session", directory, session: "s1" })).note
    await harness.call("setGoal", { sessionID: "s1", noteID: note.id, directory })

    await expect(harness.call("remove", { id: note.id })).rejects.toThrow("session goal")
    expect((await harness.call("list", { directory, session: "s1" })).notes).toHaveLength(1)
    expect((await harness.call("list", { directory, session: "s1" })).goal).toBeDefined()
    expect(harness.removes).toHaveLength(0)

    await harness.call("clearGoal", { sessionID: "s1" })
    const removed = await harness.call("remove", { id: note.id })
    expect(removed.removed).toBe(true)
    expect((await harness.call("list", { directory, session: "s1" })).notes).toEqual([])
    expect((await harness.call("list", { directory, session: "s1" })).goal).toBeUndefined()
  } finally {
    await harness.dispose()
  }
})
