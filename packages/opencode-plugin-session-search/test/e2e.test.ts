import { setDefaultTimeout, test } from "bun:test"
import path from "node:path"
import { createOpenCodeE2E } from "../../opencode-plugin-unicorn/test/e2e-utils.js"
import { checkSessionSearch } from "./e2e-utils.js"

setDefaultTimeout(180_000)
for (const combined of [false, true]) {
  for (const disabled of [false, true]) {
    test(`${combined ? "Unicorn" : "standalone"}: current-session dialogue search and scroll (${disabled ? "disabled" : "compacted long history"})`, async () => {
      const e2e = await createOpenCodeE2E({ plugin: combined ? "unicorn" : "session-search", pluginPackage: path.resolve(import.meta.dir, combined ? "../../opencode-plugin-unicorn/dist" : "../dist") })
      try { await checkSessionSearch(e2e, { combined, disabled, long: !disabled, compact: !disabled }) }
      finally { await e2e.close() }
    })
  }
}
