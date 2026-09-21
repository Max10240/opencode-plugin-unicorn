import { Plugin } from "@opencode/plugin/tui"
import type { Context } from "@opencode/plugin/tui/context"
import { PromptSearchDialog } from "./dialog.js"
import { PromptIndexer } from "./indexer.js"

export const DEFAULT_KEYBIND = "ctrl+shift+r"
export const COMMAND_ID = "max10240.prompt-search.open"

export default Plugin.define({
  id: "max10240.prompt-search.tui",
  setup(context) {
    return setupPromptSearch(context)
  },
})

export function setupPromptSearch(context: Context) {
  const indexer = new PromptIndexer(context)
  const keybind = resolveKeybind(context.options)
  let refreshTimer: ReturnType<typeof setTimeout> | undefined

  const scheduleRefresh = () => {
    if (refreshTimer !== undefined) clearTimeout(refreshTimer)
    refreshTimer = setTimeout(() => {
      refreshTimer = undefined
      void indexer.refresh()
    }, 500)
  }
  const stopEvents = context.data.listen(({ details }) => {
    if (details.type === "session.created" || details.type === "session.execution.succeeded") scheduleRefresh()
  })
  void indexer.refresh()

  const unregister = context.ui.slot({
    append: "app",
    render: () => {
      context.keymap.layer(() => ({
        mode: "global",
        priority: 10,
        commands: [
          {
            id: COMMAND_ID,
            title: "Search previous prompts",
            description: "Search prompts from all OpenCode sessions",
            group: "Prompt",
            bind: keybind,
            palette: true,
            run: () => {
              if (context.ui.router.current().type !== "session") {
                context.ui.toast.show({ message: "Open a session first", variant: "warning" })
                return
              }
              context.ui.dialog.show(() => <PromptSearchDialog context={context} indexer={indexer} />)
            },
          },
        ],
      }))
      return null
    },
  })

  return () => {
    stopEvents()
    unregister()
    if (refreshTimer !== undefined) clearTimeout(refreshTimer)
  }
}

function resolveKeybind(options: Readonly<Record<string, any>>) {
  const value = options.keybind ?? options.shortcut
  return typeof value === "string" && value.length > 0 ? value : DEFAULT_KEYBIND
}
