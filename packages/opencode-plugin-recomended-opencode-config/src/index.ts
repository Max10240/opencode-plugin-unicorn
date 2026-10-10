import { Plugin } from "@opencode/plugin"
import type { Context } from "@opencode/plugin/promise/plugin"
import rulesMarkdown from "../rules/AGENTS.md" with { type: "text" }
import commandsSnapshot from "../rules/commands.json" with { type: "json" }
import type { RecommendedCommands } from "./commands.js"
import { applyRecommendedConfig, globalConfigDirectory } from "./config.js"
import { recommendedConfigEnabled } from "./options.js"
import { parseRules } from "./rules.js"

export const recommendedRules = parseRules(rulesMarkdown)
export const recommendedCommands: RecommendedCommands = commandsSnapshot
export async function setupRecommendedOpencodeConfig(context: Pick<Context, "options">) {
  if (!recommendedConfigEnabled(context.options)) return
  try {
    await applyRecommendedConfig(globalConfigDirectory(), recommendedRules, recommendedCommands)
  } catch (error) {
    console.warn(`Recommended OpenCode config update skipped: ${error instanceof Error ? error.message : "unknown error"}`)
  }
}

export default Plugin.define({ id: "max10240.recomended-opencode-config", setup: setupRecommendedOpencodeConfig })
