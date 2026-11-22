import { Plugin } from "@opencode/plugin"
import { setupGodAgent } from "./setup.js"

export default Plugin.define({
  id: "max10240.god",
  setup: setupGodAgent,
})

export {
  DEFAULT_CACHE_TTL_MS,
  DEFAULT_TIMEOUT_MS,
  GOD_AGENT_ID,
  parseGodOptions,
  selectPromptSource,
  selectPromptSources,
} from "./options.js"
export type { PromptSources, ResolvedGodOptions } from "./options.js"
export {
  DEFAULT_FALLBACK_PATH,
  DEFAULT_FAMILY_PATHS,
  DEFAULT_MODEL_PATHS,
  DEFAULT_SOURCE_BASE,
  FALLBACK_MODEL_KEY,
} from "./defaults.js"
export { PromptLoader, expandHome, parseSource } from "./prompt.js"
export type { PromptCacheSlot, PromptLoad, PromptLoaderOptions } from "./prompt.js"
export { setupGodAgent } from "./setup.js"
export type { GodPluginContext } from "./setup.js"
