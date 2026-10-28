import { Plugin } from "@opencode/plugin/tui"
import { setupPromptSearch } from "@max10240/opencode-plugin-prompt-search/tui"
import { setupImagePreview } from "@max10240/opencode-plugin-show-img/tui"
import { setupSessionSearch } from "@max10240/opencode-plugin-session-search/tui"
import { setupSensitiveEncryptTui } from "@max10240/opencode-plugin-sensitive-encrypt/tui"
import { setupSensitiveProtectionTui } from "@max10240/opencode-plugin-sensitive-protection/tui"
import { childContext, promptSearchFeatureEnabled, sensitiveEncryptFeatureEnabled, sensitiveProtectionFeatureEnabled, sessionSearchFeatureEnabled, showImgFeatureEnabled } from "./options.js"
import { disposeAllSync } from "./cleanup.js"

export default Plugin.define({
  id: "max10240.unicorn.tui",
  setup(context) {
    const cleanups: Array<() => void> = []
    if (promptSearchFeatureEnabled(context.options)) cleanups.push(setupPromptSearch(childContext(context, "promptSearch")))
    if (sessionSearchFeatureEnabled(context.options)) cleanups.push(setupSessionSearch(childContext(context, "sessionSearch")))
    if (showImgFeatureEnabled(context.options)) cleanups.push(setupImagePreview(childContext(context, "showImg")))
    if (sensitiveEncryptFeatureEnabled(context.options)) {
      setupSensitiveEncryptTui(childContext(context, "sensitiveEncrypt"))
    }
    if (sensitiveProtectionFeatureEnabled(context.options)) {
      setupSensitiveProtectionTui(childContext(context, "sensitiveProtection"))
    }
    return () => disposeAllSync(cleanups)
  },
})
