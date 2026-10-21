import { Plugin } from "@opencode/plugin/tui"
import { setupPromptSearch } from "@max10240/opencode-plugin-prompt-search/tui"
import { setupImagePreview } from "@max10240/opencode-plugin-show-img/tui"
import { DEFAULT_KEYBIND as SESSION_SEARCH_KEYBIND, setupSessionSearch } from "@max10240/opencode-plugin-session-search/tui"
import { promptSearchFeatureEnabled, sessionSearchFeatureEnabled, showImgFeatureEnabled } from "./options.js"
import { disposeAllSync } from "./cleanup.js"

export default Plugin.define({
  id: "max10240.unicorn.tui",
  setup(context) {
    const cleanups: Array<() => void> = []
    if (promptSearchFeatureEnabled(context.options)) cleanups.push(setupPromptSearch(context))
    if (sessionSearchFeatureEnabled(context.options)) cleanups.push(setupSessionSearch(context, typeof context.options.sessionSearchKeybind === "string" ? context.options.sessionSearchKeybind : SESSION_SEARCH_KEYBIND))
    if (showImgFeatureEnabled(context.options)) cleanups.push(setupImagePreview(context))
    return () => disposeAllSync(cleanups)
  },
})
