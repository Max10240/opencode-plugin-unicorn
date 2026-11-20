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
    pluginOptions: { promptSearch: { keybind: "f7" } },
  })
  try {
    await writeFile(path.join(e2e.configDirectory, "cli.json"), `${JSON.stringify({
      plugins: [{ package: PACKAGE_ROOT, options: { promptSearch: { keybind: "f7" } } }],
    }, null, 2)}\n`)
    e2e.proxy.mock.prependFixture({
      match: { userMessage: "PROMPT_SEARCH_NEEDLE", sequenceIndex: 0 },
      response: { content: "PROMPT_SEARCH_OK" },
    })
    const sessionID = await createSession(e2e, "Prompt-Search-TUI-E2E")
    await prompt(e2e, sessionID, "PROMPT_SEARCH_NEEDLE")
    const tui = createTui(e2e, sessionID, "prompt-search-tui", { width: 160, height: 48 })
    try {
      await tui.waitFor("Prompt-Search-TUI-E2E", "the TUI did not start")
      await Bun.sleep(1_000)

      tui.send(["F7"])
      await tui.waitFor("Search previous prompts", "prompt search did not open")
      tui.type("PROMPT_SEARCH_NEEDLE")
      await tui.waitFor("1. prompt", "the prompt was not indexed")

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

      tui.send(["C-y"])
      await tui.waitFor("Copied prompt", "Ctrl+Y did not copy the selected prompt")
      tui.send(["C-p"])
      await tui.waitFor("current project ·", "Ctrl+P did not switch the scope while the dialog was open")
    } finally {
      tui.close()
    }
  } finally {
    await e2e.close()
  }
})
