import { Plugin } from "@opencode/plugin"
import { setupSendMessageAcrossSessions } from "@max10240/opencode-plugin-send-message-across-sessions/setup"
import { setupImageGen } from "@max10240/opencode-plugin-image-gen"
import { setupShowImg } from "@max10240/opencode-plugin-show-img"
import { setupSensitiveEncrypt } from "@max10240/opencode-plugin-sensitive-encrypt"
import { setupRecommendedOpencodeConfig } from "@max10240/opencode-plugin-recomended-opencode-config"
import { disposeAll } from "./cleanup.js"
import {
  childContext,
  recommendedConfigFeatureOption,
  imageGenFeatureEnabled,
  sendMessageAcrossSessionsFeatureEnabled,
  sensitiveEncryptFeatureEnabled,
  showImgFeatureEnabled,
} from "./options.js"

export default Plugin.define({
  id: "max10240.unicorn",
  async setup(ctx) {
    const cleanups: Array<() => Promise<void>> = []
    if (recommendedConfigFeatureOption(ctx.options) !== false)
      await setupRecommendedOpencodeConfig(childContext(ctx, "recommendedOpencodeConfig"))
    if (sendMessageAcrossSessionsFeatureEnabled(ctx.options))
      cleanups.push(await setupSendMessageAcrossSessions(childContext(ctx, "sendMessageAcrossSessions")))
    if (imageGenFeatureEnabled(ctx.options)) cleanups.push(await setupImageGen(childContext(ctx, "imageGen")))
    if (showImgFeatureEnabled(ctx.options)) cleanups.push(await setupShowImg(childContext(ctx, "showImg")))
    if (sensitiveEncryptFeatureEnabled(ctx.options))
      cleanups.push(await setupSensitiveEncrypt(childContext(ctx, "sensitiveEncrypt")))

    if (cleanups.length === 0) return
    return () => disposeAll(cleanups)
  },
})

export {
  recommendedConfigFeatureOption,
  imageGenFeatureEnabled,
  sendMessageAcrossSessionsFeatureEnabled,
  sensitiveEncryptFeatureEnabled,
  sessionSearchFeatureEnabled,
  showImgFeatureEnabled,
} from "./options.js"
