import { setDefaultTimeout, test } from "bun:test"
import path from "node:path"
import { createOpenCodeE2E } from "../../opencode-plugin-unicorn/test/e2e-utils.js"
import { checkShowImg } from "./e2e-utils.js"

setDefaultTimeout(180_000)

for (const mode of ["standalone", "standalone-disabled", "unicorn", "unicorn-disabled", "unicorn-nested-disabled"] as const) {
  test(`${mode}: shows server images over UI-only RPC without exposing content to a vision-capable model`, async () => {
    const e2e = await createOpenCodeE2E({
      plugin: mode.startsWith("standalone") ? "show-img" : "unicorn",
      pluginPackage: mode.startsWith("standalone") ? path.resolve(import.meta.dir, "../dist") : path.resolve(import.meta.dir, "../../opencode-plugin-unicorn/dist"),
      pluginOptions: {
        features: { recommendedOpencodeConfig: false, imageGen: false, promptSearch: false, showImg: mode === "unicorn-nested-disabled" || !mode.endsWith("disabled") },
        ...(mode === "unicorn-nested-disabled" ? { showImg: { features: { showImg: false } } } : {}),
      },
    })
    try { await checkShowImg(e2e, !mode.endsWith("disabled")) } finally { await e2e.close() }
  })
}
