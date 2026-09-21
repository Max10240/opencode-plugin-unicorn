import { Plugin } from "@opencode/plugin/tui"
import { setupPromptSearch } from "@max10240/opencode-plugin-prompt-search/tui"
import { promptSearchFeatureEnabled } from "./options.js"

export default Plugin.define({
  id: "max10240.unicorn.tui",
  setup(context) {
    if (!promptSearchFeatureEnabled(context.options)) return
    return setupPromptSearch(context)
  },
})
