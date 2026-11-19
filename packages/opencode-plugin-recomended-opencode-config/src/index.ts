import { Plugin } from "@opencode/plugin"
import type { Context } from "@opencode/plugin/promise/plugin"
import { applyRecommendedConfig, globalConfigDirectory } from "./config.js"
import { recommendedConfigEnabled } from "./options.js"
import { markdownCommands, recommendedCommands, recommendedRules } from "./snapshot.js"

export { recommendedCommands, recommendedRules } from "./snapshot.js"

export async function setupRecommendedOpencodeConfig(context: Pick<Context, "options" | "rpc">, options: { readonly apply?: boolean } = {}) {
  const { RecommendedStatusRpc } = await import("./rpc.js")
  const { recommendedStatus } = await import("./status.js")
  const enabled = (options.apply ?? true) && recommendedConfigEnabled(context.options)
  const registration = await context.rpc.register(RecommendedStatusRpc, {
    status: async () => recommendedStatus(globalConfigDirectory(), enabled),
  })
  if (enabled) {
    try {
      await applyRecommendedConfig(globalConfigDirectory(), recommendedRules, recommendedCommands, markdownCommands)
    } catch (error) {
      console.warn(`Recommended OpenCode config update skipped: ${error instanceof Error ? error.message : "unknown error"}`)
    }
  }
  return async () => {
    await registration.dispose()
  }
}

export default Plugin.define({ id: "max10240.recomended-opencode-config", setup: setupRecommendedOpencodeConfig })
