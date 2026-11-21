import { expect, setDefaultTimeout, test } from "bun:test"
import { writeFile } from "node:fs/promises"
import path from "node:path"
import { createOpenCodeE2E } from "../../opencode-plugin-unicorn/test/e2e-utils.js"
import { createSession } from "../../opencode-plugin-show-img/test/e2e-utils.js"
import { createTui } from "../../../test/tui-support.js"

setDefaultTimeout(180_000)

const PACKAGE_ROOT = path.resolve(import.meta.dir, "../../opencode-plugin-unicorn")

test.serial("typing letters filters notes while Ctrl actions manage them", async () => {
  if (Bun.spawnSync(["tmux", "-V"]).exitCode !== 0) throw new Error("tmux is required for this E2E test")
  const e2e = await createOpenCodeE2E({
    plugin: "unicorn",
    pluginPackage: PACKAGE_ROOT,
    pluginOptions: { notepad: { keybind: false } },
  })
  try {
    await writeFile(path.join(e2e.configDirectory, "cli.json"), `${JSON.stringify({
      plugins: [{ package: PACKAGE_ROOT, options: { notepad: { keybind: false } } }],
    }, null, 2)}\n`)
    const sessionID = await createSession(e2e, "Notepad-TUI-E2E")
    const tui = createTui(e2e, sessionID, "notepad-tui", { width: 160, height: 48 })
    try {
      await tui.waitFor("Notepad-TUI-E2E", "the TUI did not start")
      await Bun.sleep(1_000)
      await tui.waitFor("Compaction-E2e · GPT-5.6 Luna", "session agent and model did not settle", 30_000)

      tui.type("/notepad")
      await tui.waitFor("Capture and manage notes", "the notepad command did not appear", 10_000)
      tui.send(["Enter"])
      await tui.waitFor("No notes yet", "the notepad panel did not open")

      // The search input is focused on mount; Ctrl+N must still open the editor.
      tui.send(["C-n"])
      await tui.waitFor("New note", "the note editor did not open from the search input")
      await Bun.sleep(250)
      tui.type("KEEP_NOTE_MARKER")
      tui.send(["C-s"])
      await tui.waitFor("KEEP_NOTE_MARKER", "the note was not saved")
      await Bun.sleep(250)

      // Typing d is a search character, not the old delete action.
      tui.type("d")
      await tui.waitFor("No notes yet", "typing d did not filter the note list")
      expect(tui.pane()).not.toContain("Press ctrl+d again")
      tui.send(["BSpace"])
      await tui.waitFor("KEEP_NOTE_MARKER", "clearing the search did not restore the note")

      // Delete still works from the focused input, with a second press to confirm.
      tui.send(["C-d"])
      await tui.waitFor("Press ctrl+d again", "the first Ctrl+D did not request confirmation")
      tui.send(["C-d"])
      await tui.waitFor("No notes yet", "the second Ctrl+D did not delete the note")
    } finally {
      tui.close()
    }
  } finally {
    await e2e.close()
  }
})
