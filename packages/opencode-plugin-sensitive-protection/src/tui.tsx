import { Plugin } from "@opencode/plugin/tui"
import type { Context } from "@opencode/plugin/tui/context"
import type { ProtectionHit } from "./rpc.js"
import {
  createProtectionHistoryStore,
  HISTORY_COMMAND_ID,
  HISTORY_SLASH_NAME,
  openProtectionHistory,
  RecentProtectionChip,
  type ProtectionHistoryStore,
} from "./tui-history.jsx"

export default Plugin.define({
  id: "max10240.sensitive-protection.tui",
  setup: setupSensitiveProtectionTui,
})

export function setupSensitiveProtectionTui(context: Context) {
  if (context.options.enabled === false) return

  let store: ProtectionHistoryStore | undefined
  if (typeof context.client?.rpc === "function") {
    try {
      store = createProtectionHistoryStore(context, context.options.notifications === false ? undefined : (hit) => {
        const hint = context.keymap.shortcuts?.(HISTORY_COMMAND_ID)?.[0]
        context.ui.toast.show({
          title: hit.kind === "error" ? "Sensitive protection warning" : "Sensitive protection",
          message: messageFor(hit, hint),
          variant: hit.kind === "redacted" ? "info" : "warning",
          duration: 6_000,
          ...(hit.sessionID === undefined ? {} : { sessionID: hit.sessionID }),
        })
      })
    } catch {
      // History stays unavailable when the host does not expose plugin RPC.
    }
  }

  context.keymap.layer(() => ({
    mode: "global",
    commands: [
      {
        id: "sensitive-protection.register",
        title: "Protect sensitive file",
        description: "Register an existing file as protected",
        group: "Sensitive",
        bind: false,
        palette: true,
        slash: { name: "protect-sensitive-file-ui" },
        run: async () => {
          const file = await context.ui.dialog.prompt({
            title: "Protect sensitive file",
            description: "Existing file path",
            placeholder: "/absolute/path",
          })
          if (!file?.trim()) return
          const route = context.ui.router.current()
          if (route.type !== "session") {
            await context.ui.dialog.alert({ title: "Protect sensitive file", message: "Open a session first" })
            return
          }
          try {
            await context.client.session.command({
              sessionID: route.sessionID,
              name: "protect-sensitive-file",
              text: file.trim(),
            })
          } catch (error) {
            await context.ui.dialog.alert({
              title: "Protection failed",
              message: error instanceof Error ? error.message : "Unable to register this file",
            })
          }
        },
      },
      ...(store ? [{
        id: HISTORY_COMMAND_ID,
        title: "Sensitive protection history",
        description: "Review where protected values were blocked or redacted",
        group: "Sensitive",
        bind: historyKeybind(context.options.historyKeybind),
        palette: true as const,
        slash: { name: HISTORY_SLASH_NAME, aliases: ["sp-history"] },
        run: () => {
          const route = context.ui.router.current()
          openProtectionHistory(context, store, route.type === "session" ? route.sessionID : undefined, "all")
        },
      }] : []),
    ],
  }))

  if (!store) return
  const activeStore = store
  let disposeSlot: (() => void) | undefined
  if (context.options.notifications !== false && typeof context.ui?.slot === "function") {
    try {
      disposeSlot = context.ui.slot({
        append: "prompt.footer.status",
        render: (input) => <RecentProtectionChip context={context} store={activeStore} sessionID={input.sessionID} />,
      })
    } catch {
      // The history command and toast still work without a footer slot.
    }
  }

  return () => {
    disposeSlot?.()
    activeStore.dispose()
  }
}

function historyKeybind(value: unknown): string | false {
  if (value === false) return false
  return typeof value === "string" && value.trim() ? value.trim() : "ctrl+shift+h"
}

function messageFor(hit: ProtectionHit, hint?: string) {
  const suffix = hint ? ` · ${hint} details` : ""
  if (hit.kind === "blocked") {
    return `Blocked ${hit.tool ?? "access"} to ${shortPath(hit.file) ?? hit.label ?? "a protected file"}${suffix}`
  }
  if (hit.kind === "error") {
    return `Could not extract sensitive values from ${shortPath(hit.file) ?? hit.label ?? "a protected file"}; reads are blocked${suffix}`
  }
  const count = hit.count === 1 ? "1 sensitive value" : `${hit.count} sensitive values`
  if (hit.source === "context") return `Redacted ${count} from the model context${suffix}`
  if (hit.source === "http") return `Redacted ${count} before the provider request${suffix}`
  if (hit.tool) return `Redacted ${count} from ${hit.tool} output${suffix}`
  return `Redacted ${count} from tool output${suffix}`
}

function shortPath(value: string | undefined) {
  if (!value) return
  const parts = value.split(/[\\/]/)
  return parts.at(-1)
}
