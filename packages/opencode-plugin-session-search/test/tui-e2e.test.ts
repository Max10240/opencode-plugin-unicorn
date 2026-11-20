import { expect, setDefaultTimeout, test } from "bun:test"
import { writeFile } from "node:fs/promises"
import path from "node:path"
import { createOpenCodeE2E } from "../../opencode-plugin-unicorn/test/e2e-utils.js"
import { createSession, prompt } from "../../opencode-plugin-show-img/test/e2e-utils.js"
import { createTui } from "../../../test/tui-support.js"

setDefaultTimeout(180_000)

const PACKAGE_ROOT = path.resolve(import.meta.dir, "../../opencode-plugin-unicorn")

test.serial("typing stays in the search input and Ctrl actions work", async () => {
  if (Bun.spawnSync(["tmux", "-V"]).exitCode !== 0) throw new Error("tmux is required for this E2E test")
  const e2e = await createOpenCodeE2E({
    plugin: "unicorn",
    pluginPackage: PACKAGE_ROOT,
    pluginOptions: { sessionSearch: { keybind: "f8" } },
  })
  try {
    await writeFile(path.join(e2e.configDirectory, "cli.json"), `${JSON.stringify({
      plugins: [{ package: PACKAGE_ROOT, options: { sessionSearch: { keybind: "f8" } } }],
    }, null, 2)}\n`)
    e2e.proxy.mock.prependFixture({
      match: { userMessage: "SESSION_SEARCH_NEEDLE", sequenceIndex: 0 },
      response: { content: "SESSION_SEARCH_OK" },
    })
    const sessionID = await createSession(e2e, "Session-Search-TUI-E2E")
    await prompt(e2e, sessionID, "SESSION_SEARCH_NEEDLE")
    const tui = createTui(e2e, sessionID, "session-search-tui", { width: 160, height: 48 })
    try {
      await tui.waitFor("Session-Search-TUI-E2E", "the TUI did not start")
      await Bun.sleep(1_000)

      tui.send(["F8"])
      await tui.waitFor("Search current session", "session search did not open")
      tui.type("SESSION_SEARCH_NEEDLE")
      await tui.waitFor("1/1 matches", "the message was not indexed")

      // Results used to accept ? and j/k. Only Ctrl combos and navigation keys remain.
      tui.send(["Tab"])
      await Bun.sleep(200)
      tui.type("?")
      await Bun.sleep(300)
      expect(tui.pane()).not.toContain("Keyboard help")
      tui.send(["F1"])
      await tui.waitFor("Keyboard help", "F1 did not open help from the results list")
      tui.send(["F1"])
      await tui.waitUntil(() => !tui.pane().includes("Keyboard help"), "F1 did not close help")
      await Bun.sleep(200)

      tui.send(["C-t"])
      await tui.waitFor("user only ·", "Ctrl+T did not switch the message roles")
      tui.send(["C-y"])
      await tui.waitFor("Copied user message", "Ctrl+Y did not copy the selected message")
    } finally {
      tui.close()
    }
  } finally {
    await e2e.close()
  }
})
