import { Plugin } from "@opencode/plugin/tui"
import { setupPromptSearch } from "@max10240/opencode-plugin-prompt-search/tui"
import { setupImagePreview } from "@max10240/opencode-plugin-show-img/tui"
import { promptSearchFeatureEnabled, showImgFeatureEnabled } from "./options.js"

export default Plugin.define({
  id: "max10240.unicorn.tui",
  setup(context) {
    const cleanups: Array<() => void> = []
    if (promptSearchFeatureEnabled(context.options)) cleanups.push(setupPromptSearch(context))
    if (showImgFeatureEnabled(context.options)) cleanups.push(setupImagePreview(context))
    return () => {
      for (const cleanup of [...cleanups].reverse()) cleanup()
    }
  },
})
