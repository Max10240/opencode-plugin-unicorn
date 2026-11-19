import { Plugin } from "@opencode/plugin"
import type { Context } from "@opencode/plugin/promise/plugin"
import { NotepadRpc } from "./rpc.js"
import { NoteStore, NotepadError } from "./store.js"

export const STORAGE_KEY = "notes"

type PluginContext = Pick<Context, "options" | "storage" | "rpc">

function message(error: unknown) {
  return error instanceof Error ? error.message : "Unable to update notes"
}

export async function setupNotepad(context: PluginContext) {
  if (context.options.enabled === false || !context.rpc || !context.storage) return async () => {}

  const store = new NoteStore(
    () => context.storage.get(STORAGE_KEY),
    (value) => context.storage.set(STORAGE_KEY, value as never),
  )

  const registration = await context.rpc.register(NotepadRpc, {
    list: async (raw, request) => {
      try {
        const input = raw as { directory: string }
        return { notes: [...(await store.list(input.directory))] }
      } catch (error) {
        return request.error("invalid", message(error), {})
      }
    },
    add: async (raw, request) => {
      try {
        const input = raw as { text: string; scope: "folder" | "global"; directory: string; pinned?: boolean }
        return { note: await store.add({ text: input.text, scope: input.scope, directory: input.directory, pinned: input.pinned }) }
      } catch (error) {
        return request.error("invalid", message(error), {})
      }
    },
    update: async (raw, request) => {
      try {
        const input = raw as { id: string; text: string }
        return { note: await store.update(input.id, input.text) }
      } catch (error) {
        return request.error("invalid", message(error), {})
      }
    },
    remove: async (raw, request) => {
      try {
        const input = raw as { id: string }
        await store.remove(input.id)
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
    setScope: async (raw, request) => {
      try {
        const input = raw as { id: string; scope: "folder" | "global"; directory: string }
        return { note: await store.setScope(input.id, input.scope, input.directory) }
      } catch (error) {
        return request.error("invalid", message(error), {})
      }
    },
  })

  return async () => {
    await registration.dispose()
  }
}

export default Plugin.define({
  id: "max10240.notepad",
  setup: setupNotepad,
})
