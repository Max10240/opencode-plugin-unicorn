import { Plugin } from "@opencode/plugin/tui"
import type { Context } from "@opencode/plugin/tui/context"
import { ProtectionRpc, type ProtectionHit } from "./rpc.js"

export default Plugin.define({
  id: "max10240.sensitive-protection.tui",
  setup: setupSensitiveProtectionTui,
})

export function setupSensitiveProtectionTui(context: Context) {
  if (context.options.enabled === false) return
  context.keymap.layer(() => ({
    mode: "global",
    commands: [{
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
    }],
  }))

  if (context.options.notifications === false) return () => {}
  if (!context.client?.rpc || !context.ui?.toast) return () => {}

  let dispose: (() => void) | undefined
  try {
    dispose = context.client.rpc(ProtectionRpc).events.on("hit", (event) => {
      const hit = event.data as ProtectionHit
      context.ui.toast.show({
        title: hit.kind === "error" ? "Sensitive protection warning" : "Sensitive protection",
        message: messageFor(hit),
        variant: hit.kind === "redacted" ? "info" : "warning",
        duration: 6_000,
      })
    })
  } catch {
    // The server may not have registered the RPC event channel yet.
  }
  return () => dispose?.()
}

function messageFor(hit: ProtectionHit) {
  if (hit.kind === "blocked") {
    return `Blocked ${hit.tool ?? "access"} to ${shortPath(hit.file) ?? hit.label ?? "a protected file"}`
  }
  if (hit.kind === "error") {
    return `Could not extract sensitive values from ${shortPath(hit.file) ?? hit.label ?? "a protected file"}; reads are blocked`
  }
  const count = hit.count === 1 ? "1 sensitive value" : `${hit.count} sensitive values`
  if (hit.source === "context") return `Redacted ${count} from the model context`
  if (hit.source === "http") return `Redacted ${count} before the provider request`
  if (hit.tool) return `Redacted ${count} from ${hit.tool} output`
  return `Redacted ${count} from tool output`
}

function shortPath(value: string | undefined) {
  if (!value) return
  const parts = value.split(/[\\/]/)
  return parts.at(-1)
}
