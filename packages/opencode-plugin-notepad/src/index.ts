import { Plugin } from "@opencode/plugin"
import type { Context } from "@opencode/plugin/promise/plugin"
import { GoalStore, GOAL_INSTRUCTION_KEY, goalInstruction } from "./goal.js"
import { NotepadRpc } from "./rpc.js"
import { NoteStore, NotepadError } from "./store.js"
import type { Goal } from "./types.js"

export const STORAGE_KEY = "notes"
export const GOALS_STORAGE_KEY = "goals"

type PluginContext = Pick<Context, "options" | "storage" | "rpc" | "session" | "event">

function message(error: unknown) {
  return error instanceof Error ? error.message : "Unable to update notes"
}

async function watchDeletedGoals(
  context: PluginContext,
  goals: GoalStore,
  removeInstruction: (sessionID: string) => Promise<unknown>,
  signal: AbortSignal,
) {
  while (!signal.aborted) {
    try {
      for await (const event of context.event.subscribe({ signal })) {
        if (event.type !== "session.deleted") continue
        const sessionID = event.data.sessionID
        if (typeof sessionID !== "string") continue
        try {
          await goals.clear(sessionID)
        } catch {}
        await removeInstruction(sessionID).catch(() => undefined)
      }
    } catch {
      // Reconnect below so deletions during a dropped stream still clear their goals.
    }
    if (signal.aborted) return
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 1_000)
      signal.addEventListener("abort", () => {
        clearTimeout(timer)
        resolve()
      }, { once: true })
    })
  }
}

export async function setupNotepad(context: PluginContext) {
  if (context.options.enabled === false || !context.rpc || !context.storage) return async () => {}

  const store = new NoteStore(
    () => context.storage.get(STORAGE_KEY),
    (value) => context.storage.set(STORAGE_KEY, value as never),
  )
  const goals = new GoalStore(
    () => context.storage.get(GOALS_STORAGE_KEY),
    (value) => context.storage.set(GOALS_STORAGE_KEY, value as never),
  )
  const instructions = context.session.instructions.entry

  const putGoalInstruction = (sessionID: string, text: string) =>
    instructions.put({ sessionID, key: GOAL_INSTRUCTION_KEY, value: goalInstruction(text) })
  const removeGoalInstruction = (sessionID: string) =>
    instructions.remove({ sessionID, key: GOAL_INSTRUCTION_KEY })

  const registration = await context.rpc.register(NotepadRpc, {
    list: async (raw, request) => {
      try {
        const input = raw as { directory: string; session?: string }
        const notes = await store.list(input.directory, input.session)
        let goal: Goal | undefined
        if (input.session !== undefined) {
          try {
            goal = await goals.get(input.session)
          } catch {}
        }
        return { notes: [...notes], ...(goal === undefined ? {} : { goal }) }
      } catch (error) {
        return request.error("invalid", message(error), {})
      }
    },
    add: async (raw, request) => {
      try {
        const input = raw as { text: string; scope: "session" | "folder" | "global"; directory: string; session?: string; pinned?: boolean }
        return { note: await store.add({ text: input.text, scope: input.scope, directory: input.directory, session: input.session, pinned: input.pinned }) }
      } catch (error) {
        return request.error("invalid", message(error), {})
      }
    },
    update: async (raw, request) => {
      try {
        const input = raw as { id: string; text: string }
        const note = await store.update(input.id, input.text)
        // Goal metadata must never make an ordinary note edit fail.
        let changed: { updated: Array<{ sessionID: string; goal: Goal }>; cleared: string[] } = { updated: [], cleared: [] }
        try {
          changed = await goals.updateNote(note)
        } catch {}
        const cleared = [...changed.cleared]
        for (const entry of changed.updated) {
          try {
            await putGoalInstruction(entry.sessionID, entry.goal.text)
          } catch {
            await goals.clear(entry.sessionID).catch(() => undefined)
            await removeGoalInstruction(entry.sessionID).catch(() => undefined)
            cleared.push(entry.sessionID)
          }
        }
        for (const sessionID of changed.cleared) await removeGoalInstruction(sessionID).catch(() => undefined)
        return { note, ...(cleared.length > 0 ? { goalCleared: true } : {}) }
      } catch (error) {
        return request.error("invalid", message(error), {})
      }
    },
    remove: async (raw, request) => {
      try {
        const input = raw as { id: string }
        let referenced: string[] = []
        try {
          referenced = await goals.references(input.id)
        } catch {}
        if (referenced.length > 0) throw new NotepadError("This note is a session goal. Clear the goal before deleting it.")
        await store.remove(input.id)
        try {
          const cleared = await goals.removeNote(input.id)
          for (const sessionID of cleared) await removeGoalInstruction(sessionID).catch(() => undefined)
        } catch {}
        return { removed: true }
      } catch (error) {
        return request.error("invalid", message(error), {})
      }
    },
    setPinned: async (raw, request) => {
      try {
        const input = raw as { id: string; pinned: boolean }
        return { note: await store.setPinned(input.id, input.pinned) }
      } catch (error) {
        return request.error("invalid", message(error), {})
      }
    },
    setGoal: async (raw, request) => {
      try {
        const input = raw as { sessionID: string; noteID: string; directory: string }
        const visible = await store.list(input.directory, input.sessionID)
        const note = visible.find((item) => item.id === input.noteID)
        if (!note) throw new NotepadError("Note not found")
        const previous = await goals.get(input.sessionID)
        const goal = await goals.set(input.sessionID, note, input.directory)
        try {
          await putGoalInstruction(input.sessionID, goal.text)
        } catch (error) {
          if (previous === undefined) await goals.clear(input.sessionID)
          else await goals.restore(input.sessionID, previous)
          throw error
        }
        return { goal }
      } catch (error) {
        return request.error("invalid", message(error), {})
      }
    },
    clearGoal: async (raw, request) => {
      try {
        const input = raw as { sessionID: string }
        const previous = await goals.clear(input.sessionID)
        try {
          await removeGoalInstruction(input.sessionID)
        } catch (error) {
          if (previous !== undefined) await goals.restore(input.sessionID, previous)
          throw error
        }
        return { cleared: previous !== undefined }
      } catch (error) {
        return request.error("invalid", message(error), {})
      }
    },
  })

  const controller = new AbortController()
  void watchDeletedGoals(context, goals, removeGoalInstruction, controller.signal)

  return async () => {
    controller.abort()
    await registration.dispose()
  }
}

export default Plugin.define({
  id: "max10240.notepad",
  setup: setupNotepad,
})
