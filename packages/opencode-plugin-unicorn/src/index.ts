import { Plugin } from "@opencode/plugin"
import { setupGodAgent } from "@max10240/opencode-plugin-god"
import { setupSendMessageAcrossSessions } from "@max10240/opencode-plugin-send-message-across-sessions/setup"
import { setupImageGen } from "@max10240/opencode-plugin-image-gen"
import { setupNotepad } from "@max10240/opencode-plugin-notepad"
import { setupShowImg } from "@max10240/opencode-plugin-show-img"
import { setupOpencodeGoUsage } from "@max10240/opencode-plugin-opencode-go-usage"
import { setupSensitiveEncrypt } from "@max10240/opencode-plugin-sensitive-encrypt"
import { setupSensitiveProtection } from "@max10240/opencode-plugin-sensitive-protection"
import { setupRecommendedOpencodeConfig } from "@max10240/opencode-plugin-recomended-opencode-config"
import { setupDeadLoop } from "@max10240/opencode-plugin-dead-loop"
import { disposeAll } from "./cleanup.js"
import { UnicornStatusRpc } from "./status-rpc.js"
import { unicornRuntimeStatus } from "./status.js"
import {
  childContext,
  recommendedConfigFeatureOption,
  godFeatureEnabled,
  imageGenFeatureEnabled,
  notepadFeatureEnabled,
  sendMessageAcrossSessionsFeatureEnabled,
  sensitiveEncryptFeatureEnabled,
  sensitiveProtectionFeatureEnabled,
  showImgFeatureEnabled,
  opencodeGoUsageFeatureEnabled,
  deadLoopFeatureEnabled,
} from "./options.js"

export default Plugin.define({
  id: "max10240.unicorn",
  async setup(ctx) {
    const cleanups: Array<() => Promise<void>> = []
    const statusRpc = await ctx.rpc.register(UnicornStatusRpc, {
      runtime: async () => unicornRuntimeStatus(),
    })
    cleanups.push(async () => {
      await statusRpc.dispose()
    })
    cleanups.push(await setupRecommendedOpencodeConfig(
      childContext(ctx, "recommendedOpencodeConfig"),
      { apply: recommendedConfigFeatureOption(ctx.options) !== false },
    ))
    if (godFeatureEnabled(ctx.options)) cleanups.push(await setupGodAgent(childContext(ctx, "god")))
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
    if (deadLoopFeatureEnabled(ctx.options))
      cleanups.push(await setupDeadLoop(childContext(ctx, "deadLoop")))

    if (cleanups.length === 0) return
    return () => disposeAll(cleanups)
  },
})

export {
  recommendedConfigFeatureOption,
  godFeatureEnabled,
  imageGenFeatureEnabled,
  notepadFeatureEnabled,
  sendMessageAcrossSessionsFeatureEnabled,
  sensitiveEncryptFeatureEnabled,
  sensitiveProtectionFeatureEnabled,
  sessionSearchFeatureEnabled,
  nonBlockingFeatureEnabled,
  showImgFeatureEnabled,
  opencodeGoUsageFeatureEnabled,
  deadLoopFeatureEnabled,
} from "./options.js"
