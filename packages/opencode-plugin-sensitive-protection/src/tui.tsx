import { Plugin } from "@opencode/plugin/tui"
import type { Context } from "@opencode/plugin/tui/context"

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
}
