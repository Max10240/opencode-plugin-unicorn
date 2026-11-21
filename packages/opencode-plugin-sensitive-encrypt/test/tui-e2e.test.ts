import { expect, setDefaultTimeout, test } from "bun:test"
import { writeFile } from "node:fs/promises"
import path from "node:path"
import { createOpenCodeE2E } from "../../opencode-plugin-unicorn/test/e2e-utils.js"
import { createSession } from "../../opencode-plugin-show-img/test/e2e-utils.js"
import { createTui } from "../../../test/tui-support.js"

setDefaultTimeout(180_000)

const PACKAGE_ROOT = path.resolve(import.meta.dir, "../../opencode-plugin-unicorn")

test.serial("typing stays in the textarea and Ctrl actions work", async () => {
  if (Bun.spawnSync(["tmux", "-V"]).exitCode !== 0) throw new Error("tmux is required for this E2E test")
  const e2e = await createOpenCodeE2E({
    plugin: "unicorn",
    pluginPackage: PACKAGE_ROOT,
    pluginOptions: { sensitiveEncrypt: {} },
  })
  try {
    await writeFile(path.join(e2e.configDirectory, "cli.json"), `${JSON.stringify({
      plugins: [{ package: PACKAGE_ROOT, options: { sensitiveEncrypt: {} } }],
    }, null, 2)}\n`)
    const sessionID = await createSession(e2e, "Sensitive-Encrypt-TUI-E2E")
    const tui = createTui(e2e, sessionID, "sensitive-encrypt-tui", { width: 160, height: 48 })
    try {
      await tui.waitFor("Sensitive-Encrypt-TUI-E2E", "the TUI did not start")
      await Bun.sleep(1_000)
      // The composer commits the session's agent/model and plugin layers register after the
      // first render. Wait for both before relying on a slash command.
      await tui.waitFor("Compaction-E2e · GPT-5.6 Luna", "session agent and model did not settle", 30_000)
      tui.type("/encrypt-sensitive")
      await tui.waitFor("Encrypt in-memory text or a file", "the encryption command did not appear", 10_000)
      tui.send(["Enter"])
      await tui.waitFor("Type any text to encrypt", "the encryption panel did not open", 10_000)
      await Bun.sleep(250)
      tui.type("SENSITIVE_TUI_TEXT")
      await tui.waitFor("Masked · 18 characters", "typing did not reach the textarea")

      tui.send(["C-r"])
      await tui.waitFor("Visible · 18 characters", "Ctrl+R did not reveal the text")
      tui.send(["C-r"])
      await tui.waitFor("Masked · 18 characters", "Ctrl+R did not hide the text again")

      tui.send(["C-t"])
      await tui.waitFor("[File]", "Ctrl+T did not switch to file mode")
      tui.send(["C-t"])
      await tui.waitFor("[Text]", "Ctrl+T did not switch back to text mode")

      tui.send(["F1"])
      await tui.waitFor("Keyboard help", "F1 did not open help")
      tui.send(["Escape"])
      await tui.waitUntil(() => !tui.pane().includes("Keyboard help"), "Escape did not close help")

      tui.send(["Enter"])
      await tui.waitFor("Encrypted with key", "Enter did not encrypt the text")
      tui.send(["c"])
      await tui.waitFor("Copied ciphertext", "copy did not run from the result dialog")
    } finally {
      tui.close()
    }
  } finally {
    await e2e.close()
  }
})
