import { Plugin } from "@opencode/plugin/tui"
import { setupPromptSearch } from "@max10240/opencode-plugin-prompt-search/tui"
import { setupImagePreview } from "@max10240/opencode-plugin-show-img/tui"
import { setupOpencodeGoUsageTui } from "@max10240/opencode-plugin-opencode-go-usage/tui"
import { setupNotepadTui } from "@max10240/opencode-plugin-notepad/tui"
import { setupSessionSearch } from "@max10240/opencode-plugin-session-search/tui"
import { setupNonBlocking } from "@max10240/opencode-plugin-non-blocking/tui"
import { setupSensitiveEncryptTui } from "@max10240/opencode-plugin-sensitive-encrypt/tui"
import { setupSensitiveProtectionTui } from "@max10240/opencode-plugin-sensitive-protection/tui"
import { childContext, nonBlockingFeatureEnabled, notepadFeatureEnabled, opencodeGoUsageFeatureEnabled, promptSearchFeatureEnabled, sensitiveEncryptFeatureEnabled, sensitiveProtectionFeatureEnabled, sessionSearchFeatureEnabled, showImgFeatureEnabled } from "./options.js"
import { disposeAllSync } from "./cleanup.js"

export default Plugin.define({
  id: "max10240.unicorn.tui",
  setup(context) {
    const cleanups: Array<() => void> = []
    if (promptSearchFeatureEnabled(context.options)) cleanups.push(setupPromptSearch(childContext(context, "promptSearch")))
    if (sessionSearchFeatureEnabled(context.options)) cleanups.push(setupSessionSearch(childContext(context, "sessionSearch")))
    if (nonBlockingFeatureEnabled(context.options)) cleanups.push(setupNonBlocking(childContext(context, "nonBlocking")))
    if (showImgFeatureEnabled(context.options)) cleanups.push(setupImagePreview(childContext(context, "showImg")))
    if (opencodeGoUsageFeatureEnabled(context.options))
      cleanups.push(setupOpencodeGoUsageTui(childContext(context, "opencodeGoUsage")))
    if (notepadFeatureEnabled(context.options)) setupNotepadTui(childContext(context, "notepad"))
    if (sensitiveEncryptFeatureEnabled(context.options)) {
      setupSensitiveEncryptTui(childContext(context, "sensitiveEncrypt"))
    }
    if (sensitiveProtectionFeatureEnabled(context.options)) {
      const cleanup = setupSensitiveProtectionTui(childContext(context, "sensitiveProtection"))
      if (cleanup) cleanups.push(cleanup)
    }
    return () => disposeAllSync(cleanups)
  },
})
