import { setDefaultTimeout, test } from "bun:test"
import path from "node:path"
import { createOpenCodeE2E } from "../../opencode-plugin-unicorn/test/e2e-utils.js"
import { checkShowImg } from "./e2e-utils.js"

setDefaultTimeout(180_000)

// Feature-gate combinations are covered by Unicorn options and assembly tests.
// E2E covers standalone, enabled Unicorn, and disabled Unicorn integration.
for (const mode of ["standalone", "unicorn", "unicorn-disabled"] as const) {
  test(`${mode}: shows server images over UI-only RPC without exposing content to a vision-capable model`, async () => {
    const e2e = await createOpenCodeE2E({
      plugin: mode.startsWith("standalone") ? "show-img" : "unicorn",
      pluginPackage: mode.startsWith("standalone") ? path.resolve(import.meta.dir, "../dist") : path.resolve(import.meta.dir, "../../opencode-plugin-unicorn/dist"),
      pluginOptions: {
        features: { recommendedOpencodeConfig: false, imageGen: false, promptSearch: false, showImg: !mode.endsWith("disabled") },
      },
    })
    try { await checkShowImg(e2e, !mode.endsWith("disabled")) } finally { await e2e.close() }
  })
}
