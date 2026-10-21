import { Plugin } from "@opencode/plugin/tui"
import type { Context } from "@opencode/plugin/tui/context"
import { createEffect, createSignal, onCleanup } from "solid-js"
import { SessionSearchController } from "./controller.js"
import { SessionSearchDialog } from "./dialog.js"
import { navigationHost, SessionNavigator } from "./navigation.js"
import { resolveSearchKeybind, sessionSearchEnabled } from "./options.js"
import { eventForSession } from "./events.js"
import { registerKeymap } from "./keymap.js"

export { DEFAULT_KEYBIND } from "./options.js"
export const COMMAND_ID = "max10240.session-search.open"

export function setupSessionSearch(context: Context, selectedKeybind: unknown = context.options.keybind) {
  if (!sessionSearchEnabled(context.options)) return () => {}
  const keybind = resolveSearchKeybind(selectedKeybind)
  const [revision, setRevision] = createSignal(0)
  const [busy, setBusy] = createSignal(false)
  const changed = () => setRevision((value) => value + 1)
  const controller = new SessionSearchController({
    info: (sessionID, signal) => context.client.session.get({ sessionID }, { signal }),
    page: (sessionID, type, cursor, signal) => context.client.message.list({ sessionID, type, limit: 200, ...(cursor ? { cursor } : { order: "desc" as const }) }, { signal }),
  }, changed)
  const navigator = new SessionNavigator(navigationHost(context), setBusy)
  const pending = new Set<string>()
  let timer: ReturnType<typeof setTimeout> | undefined
  let openSession: string | undefined
  let structural = false
  let lifetime: AbortController | undefined
  const flush = () => {
    timer = undefined
    if (!openSession) return
    if (structural) {
      structural = false; pending.clear()
      void controller.open(openSession, lifetime?.signal)
      return
    }
    if (controller.loading) { timer = setTimeout(flush, 150); return }
    if (!controller.ready) { pending.clear(); return }
    for (const id of pending) {
      const message = context.data.session.message.get(openSession, id)
      if (message) controller.merge(message)
    }
    pending.clear()
  }
  const stop = context.data.listen(({ details }) => {
    const data = details.data
    const kind = eventForSession(details.type, data, controller.sessionID)
    if (!kind) return
    controller.invalidate(kind === "reload")
    if (!openSession) return
    if (kind === "reload") structural = true
    const id = "assistantMessageID" in data ? data.assistantMessageID : "messageID" in data ? data.messageID : "inboxID" in data ? data.inboxID : undefined
    if (typeof id === "string") pending.add(id)
    if (kind === "settled") {
      for (const message of context.data.session.message.list(openSession)) if (message.type === "user" || message.type === "assistant") pending.add(message.id)
    }
    if (!timer) timer = setTimeout(flush, structural ? 100 : 150)
  })
  const unregister = context.ui.slot({ append: "app", render: () => {
    createEffect(() => {
      const route = context.ui.router.current()
      if (controller.sessionID && (route.type !== "session" || route.sessionID !== controller.sessionID)) {
        if (openSession) context.ui.dialog.clear()
        lifetime?.abort(); openSession = undefined; controller.dispose(); navigator.cancel()
      }
    })
    registerKeymap(context, () => ({ mode: "global", priority: 10, commands: [{
      id: COMMAND_ID, title: "Search current session", description: "Search user and agent dialogue in this session", group: "Session", bind: keybind, palette: true,
      run: () => {
        const route = context.ui.router.current()
        if (route.type !== "session") { context.ui.toast.show({ message: "Open a session first", variant: "warning" }); return }
        navigator.cancel(); context.ui.dialog.clear(); lifetime?.abort()
        const owner = new AbortController()
        lifetime = owner; openSession = route.sessionID
        context.ui.dialog.show(() => <SessionSearchDialog context={context} controller={controller} navigator={navigator} sessionID={route.sessionID} revision={revision} lifetime={owner} />, () => {
          owner.abort()
          if (lifetime !== owner) return
          openSession = undefined; pending.clear(); structural = false
          if (timer) clearTimeout(timer)
          timer = undefined
        })
      },
    }] }))
    registerKeymap(context, () => ({ mode: "global", priority: 30, enabled: busy, commands: [{ bind: "escape", title: "Cancel message navigation", run: () => navigator.cancel() }] }))
    onCleanup(() => navigator.cancel())
    return null
  } })
  return () => {
    stop()
    if (openSession) context.ui.dialog.clear()
    unregister()
    if (timer) clearTimeout(timer)
    lifetime?.abort(); controller.dispose(); navigator.cancel()
  }
}

export default Plugin.define({ id: "max10240.session-search.tui", setup: setupSessionSearch })
