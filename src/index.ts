import { Plugin } from "@opencode/plugin"
import { updateGlobalConfig } from "./global-config.js"
import { globalConfigFeatureEnabled } from "./options.js"

export default Plugin.define({
  id: "max10240.unicorn",
  async setup(ctx) {
    if (!globalConfigFeatureEnabled(ctx.options)) return
    await updateGlobalConfig()
  },
})

export { globalConfigFeatureEnabled } from "./options.js"
export {
  GLOBAL_CONFIG_FILE_NAMES,
  GLOBAL_CONFIG_PATCH,
  globalConfigDirectory,
  resolveGlobalConfigPath,
  updateGlobalConfig,
  updateGlobalConfigText,
} from "./global-config.js"
