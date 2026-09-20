import { Plugin } from "@opencode/plugin"
import { setupSendMessageAcrossSessions } from "@max10240/opencode-plugin-send-message-across-sessions/setup"
import { updateGlobalConfig } from "./global-config.js"
import { globalConfigFeatureEnabled, sendMessageAcrossSessionsFeatureEnabled } from "./options.js"

export default Plugin.define({
  id: "max10240.unicorn",
  async setup(ctx) {
    const cleanups: Array<() => Promise<void>> = []
    if (globalConfigFeatureEnabled(ctx.options)) await updateGlobalConfig()
    if (sendMessageAcrossSessionsFeatureEnabled(ctx.options))
      cleanups.push(await setupSendMessageAcrossSessions(ctx))

    if (cleanups.length === 0) return
    return async () => {
      for (const cleanup of [...cleanups].reverse()) await cleanup()
    }
  },
})

export { globalConfigFeatureEnabled, sendMessageAcrossSessionsFeatureEnabled } from "./options.js"
export {
  GLOBAL_CONFIG_FILE_NAMES,
  GLOBAL_CONFIG_PATCH,
  globalConfigDirectory,
  resolveGlobalConfigPath,
  updateGlobalConfig,
  updateGlobalConfigText,
} from "./global-config.js"
