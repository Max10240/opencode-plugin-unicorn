import { Plugin } from "@opencode/plugin/tui"
import type { Context } from "@opencode/plugin/tui/context"
import { RetryController } from "./controller.js"
import { parseRetryOptions, type RetryOptions } from "./options.js"

export const COMMAND_ID = "max10240.retry.now"
export const SLASH_COMMAND = "retry"

export default Plugin.define({
  id: "max10240.retry.tui",
  setup(context) {
    return setupRetryTui(context)
  },
})

export function setupRetryTui(context: Context) {
  let options: RetryOptions
  try {
    options = parseRetryOptions(context.options)
  } catch (error) {
    console.warn(`Retry plugin disabled: ${error instanceof Error ? error.message : "invalid options"}`)
    return
  }
  if (!options.enabled) return

  const controller = new RetryController({
    continueText: options.continueText,
    timeoutMs: options.timeoutMs,
    status: (sessionID) => context.data.session.status(sessionID),
    interrupt: (sessionID) => context.client.session.interrupt({ sessionID }),
    waitIdle: (sessionID, signal) => context.client.experimental.session.wait({ sessionID }, { signal }),
    send: async (sessionID, text) => {
      await context.client.session.prompt({ sessionID, text, delivery: "steer" })
    },
    enqueue: async (sessionID, text) => {
      await context.client.session.prompt({ sessionID, text, delivery: "queue" })
    },
    onError: (message) => {
      void context.ui.toast.show({ message, variant: "error" })
    },
    onQueued: () => {
      void context.ui.toast.show({ message: "Retry: prompt queued until the current turn stops", variant: "warning" })
    },
  })

  const run = () => {
    const route = context.ui.router.current()
    if (route.type !== "session") {
      void context.ui.toast.show({ message: "Open a session first", variant: "warning" })
      return
    }
    void controller.run(route.sessionID)
  }

  context.keymap.layer(() => ({
    priority: 10,
    commands: [
      {
        id: COMMAND_ID,
        title: "Retry with Continue",
        description: "Interrupt the current turn and send the configured Continue prompt",
        group: "Session",
        bind: options.keybind === false ? false : options.keybind,
        slash: { name: SLASH_COMMAND, arguments: true },
        run,
      },
    ],
  }))

  return () => controller.dispose()
}
