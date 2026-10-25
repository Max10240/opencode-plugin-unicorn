import { Plugin } from "@opencode/plugin"
import type { Context } from "@opencode/plugin/promise/plugin"
import rulesMarkdown from "../rules/AGENTS.md" with { type: "text" }
import commandsSnapshot from "../rules/commands.json" with { type: "json" }
import type { RecommendedCommand, RecommendedCommands } from "./commands.js"
import { applyRecommendedConfig, globalConfigDirectory } from "./config.js"
import { recommendedConfigEnabled } from "./options.js"
import { parseRules } from "./rules.js"

export const recommendedRules = parseRules(rulesMarkdown)
const snapshot: Readonly<Record<string, RecommendedCommand & { readonly source?: string }>> = commandsSnapshot
export const recommendedCommands: RecommendedCommands = Object.fromEntries(Object.entries(snapshot).map(([name, { source: _, ...command }]) => [name, command]))
const markdownCommands = new Set(Object.entries(snapshot).filter(([, command]) => command.source === "markdown").map(([name]) => name))
export async function setupRecommendedOpencodeConfig(context: Pick<Context, "options">) {
  if (!recommendedConfigEnabled(context.options)) return
  try {
    await applyRecommendedConfig(globalConfigDirectory(), recommendedRules, recommendedCommands, markdownCommands)
  } catch (error) {
    console.warn(`Recommended OpenCode config update skipped: ${error instanceof Error ? error.message : "unknown error"}`)
  }
}

export default Plugin.define({ id: "max10240.recomended-opencode-config", setup: setupRecommendedOpencodeConfig })
