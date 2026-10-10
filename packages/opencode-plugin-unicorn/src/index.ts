import { Plugin } from "@opencode/plugin"
import { setupSendMessageAcrossSessions } from "@max10240/opencode-plugin-send-message-across-sessions/setup"
import { setupImageGen } from "@max10240/opencode-plugin-image-gen"
import { setupShowImg } from "@max10240/opencode-plugin-show-img"
import { setupRecommendedOpencodeConfig } from "@max10240/opencode-plugin-recomended-opencode-config"
import { disposeAll } from "./cleanup.js"
import {
  recommendedConfigFeatureOption,
  imageGenFeatureEnabled,
  sendMessageAcrossSessionsFeatureEnabled,
  showImgFeatureEnabled,
} from "./options.js"

export default Plugin.define({
  id: "max10240.unicorn",
  async setup(ctx) {
    const cleanups: Array<() => Promise<void>> = []
    await setupRecommendedOpencodeConfig({ options: { enabled: recommendedConfigFeatureOption(ctx.options) } })
    if (sendMessageAcrossSessionsFeatureEnabled(ctx.options))
      cleanups.push(await setupSendMessageAcrossSessions(ctx))
    if (imageGenFeatureEnabled(ctx.options)) cleanups.push(await setupImageGen(ctx))
    if (showImgFeatureEnabled(ctx.options)) cleanups.push(await setupShowImg(ctx))

    if (cleanups.length === 0) return
    return () => disposeAll(cleanups)
  },
})

export {
  recommendedConfigFeatureOption,
  imageGenFeatureEnabled,
  sendMessageAcrossSessionsFeatureEnabled,
  showImgFeatureEnabled,
} from "./options.js"
