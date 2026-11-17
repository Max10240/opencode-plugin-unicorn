import { Plugin } from "@opencode/plugin"
import { setupGodAgent } from "./setup.js"

export default Plugin.define({
  id: "max10240.god",
  setup: setupGodAgent,
})

export { GOD_AGENT_ID, parseGodOptions, selectPromptSource } from "./options.js"
export type { ResolvedGodOptions } from "./options.js"
export { PromptLoader, expandHome, parseSource } from "./prompt.js"
export type { PromptLoad, PromptLoaderOptions } from "./prompt.js"
export { setupGodAgent } from "./setup.js"
export type { GodPluginContext } from "./setup.js"
