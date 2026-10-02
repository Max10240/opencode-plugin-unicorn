import { Plugin } from "@opencode/plugin"
import { setupSendMessageAcrossSessions } from "@max10240/opencode-plugin-send-message-across-sessions/setup"
import { setupImageGen } from "@max10240/opencode-plugin-image-gen"
import { setupShowImg } from "@max10240/opencode-plugin-show-img"
import { updateGlobalConfig } from "./global-config.js"
import {
  globalConfigFeatureEnabled,
  imageGenFeatureEnabled,
  sendMessageAcrossSessionsFeatureEnabled,
  showImgFeatureEnabled,
} from "./options.js"

export default Plugin.define({
  id: "max10240.unicorn",
  async setup(ctx) {
    const cleanups: Array<() => Promise<void>> = []
    if (globalConfigFeatureEnabled(ctx.options)) await updateGlobalConfig()
    if (sendMessageAcrossSessionsFeatureEnabled(ctx.options))
      cleanups.push(await setupSendMessageAcrossSessions(ctx))
    if (imageGenFeatureEnabled(ctx.options)) cleanups.push(await setupImageGen(ctx))
    if (showImgFeatureEnabled(ctx.options)) cleanups.push(await setupShowImg(ctx))

    if (cleanups.length === 0) return
    return async () => {
      for (const cleanup of [...cleanups].reverse()) await cleanup()
    }
  },
})

export {
  globalConfigFeatureEnabled,
  imageGenFeatureEnabled,
  sendMessageAcrossSessionsFeatureEnabled,
  showImgFeatureEnabled,
} from "./options.js"
export {
  GLOBAL_CONFIG_FILE_NAMES,
  GLOBAL_CONFIG_PATCH,
  globalConfigDirectory,
  resolveGlobalConfigPath,
  updateGlobalConfig,
  updateGlobalConfigText,
} from "./global-config.js"
