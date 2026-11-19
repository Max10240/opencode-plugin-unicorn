import rulesMarkdown from "../rules/AGENTS.md" with { type: "text" }
import commandsSnapshot from "../rules/commands.json" with { type: "json" }
import type { RecommendedCommand, RecommendedCommands } from "./commands.js"
import { parseRules } from "./rules.js"

export const recommendedRules = parseRules(rulesMarkdown)
const snapshot: Readonly<Record<string, RecommendedCommand & { readonly source?: string }>> = commandsSnapshot
export const recommendedCommands: RecommendedCommands = Object.fromEntries(Object.entries(snapshot).map(([name, { source: _, ...command }]) => [name, command]))
export const markdownCommands = new Set(Object.entries(snapshot).filter(([, command]) => command.source === "markdown").map(([name]) => name))
