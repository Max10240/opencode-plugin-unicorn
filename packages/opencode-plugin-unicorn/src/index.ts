import { Plugin } from "@opencode/plugin"
import { setupSendMessageAcrossSessions } from "@max10240/opencode-plugin-send-message-across-sessions/setup"
import { setupImageGen } from "@max10240/opencode-plugin-image-gen"
import { setupNotepad } from "@max10240/opencode-plugin-notepad"
import { setupShowImg } from "@max10240/opencode-plugin-show-img"
import { setupOpencodeGoUsage } from "@max10240/opencode-plugin-opencode-go-usage"
import { setupSensitiveEncrypt } from "@max10240/opencode-plugin-sensitive-encrypt"
import { setupSensitiveProtection } from "@max10240/opencode-plugin-sensitive-protection"
import { setupRecommendedOpencodeConfig } from "@max10240/opencode-plugin-recomended-opencode-config"
import { disposeAll } from "./cleanup.js"
import {
  childContext,
  recommendedConfigFeatureOption,
  imageGenFeatureEnabled,
  notepadFeatureEnabled,
  sendMessageAcrossSessionsFeatureEnabled,
  sensitiveEncryptFeatureEnabled,
  sensitiveProtectionFeatureEnabled,
  showImgFeatureEnabled,
  opencodeGoUsageFeatureEnabled,
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
    if (notepadFeatureEnabled(ctx.options)) cleanups.push(await setupNotepad(childContext(ctx, "notepad")))
    if (showImgFeatureEnabled(ctx.options)) cleanups.push(await setupShowImg(childContext(ctx, "showImg")))
    if (opencodeGoUsageFeatureEnabled(ctx.options))
      cleanups.push(await setupOpencodeGoUsage(childContext(ctx, "opencodeGoUsage")))
    if (sensitiveProtectionFeatureEnabled(ctx.options))
      cleanups.push(await setupSensitiveProtection(childContext(ctx, "sensitiveProtection")))
    if (sensitiveEncryptFeatureEnabled(ctx.options))
      cleanups.push(await setupSensitiveEncrypt(childContext(ctx, "sensitiveEncrypt")))

    if (cleanups.length === 0) return
    return () => disposeAll(cleanups)
  },
})

export {
  recommendedConfigFeatureOption,
  imageGenFeatureEnabled,
  notepadFeatureEnabled,
  sendMessageAcrossSessionsFeatureEnabled,
  sensitiveEncryptFeatureEnabled,
  sensitiveProtectionFeatureEnabled,
  sessionSearchFeatureEnabled,
  nonBlockingFeatureEnabled,
  showImgFeatureEnabled,
  opencodeGoUsageFeatureEnabled,
} from "./options.js"
