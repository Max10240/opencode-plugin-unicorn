import { expect, setDefaultTimeout, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createOpenCodeE2E } from "../../opencode-plugin-unicorn/test/e2e-utils.js"
import { createSession, prompt } from "../../opencode-plugin-show-img/test/e2e-utils.js"
import { createTui } from "../../../test/tui-support.js"

setDefaultTimeout(180_000)

test("reports a redacted read in the toast, footer chip, and history dialog", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sensitive-protection-tui-"))
  const secret = path.join(root, "secret.json")
  await writeFile(secret, JSON.stringify({ token: "TUI_NOTIFY_TOKEN_123" }))
  const pluginPackage = path.resolve(import.meta.dir, "../dist")
  const options = {
    notifications: true,
    files: [{ path: secret, label: "Test credential", format: "json", keys: ["token"] }],
  }
  const e2e = await createOpenCodeE2E({
    plugin: "sensitive-protection",
    pluginPackage,
    pluginOptions: options,
  })
  try {
    const sessionID = await createSession(e2e, "Sensitive-Protection-Toast")
    await writeFile(path.join(e2e.configDirectory, "cli.json"), `${JSON.stringify({
      plugins: [{ package: pluginPackage, options }],
    }, null, 2)}\n`)
    const tui = createTui(e2e, sessionID, "sensitive-protection-toast")
    try {
      await tui.waitFor("Sensitive-Protection-Toast", "TUI did not start")
      e2e.proxy.mock.prependFixture({
        match: { userMessage: "E2E_PROTECTION_TOAST", sequenceIndex: 0 },
        response: {
          toolCalls: [{ id: "call_protected_read", name: "read", arguments: JSON.stringify({ path: secret }) }],
        },
      })
      e2e.proxy.mock.prependFixture({ match: { toolCallId: "call_protected_read" }, response: { content: "TOAST_DONE" } })
      await prompt(e2e, sessionID, "E2E_PROTECTION_TOAST")
      await tui.waitFor("Sensitive protection", "protection toast did not appear")
      await tui.waitFor("from read output", "protection toast did not identify the redacted read")
      await tui.waitFor("redacted · details", "protection footer chip did not appear")
      expect(tui.pane()).not.toContain("TUI_NOTIFY_TOKEN_123")

      tui.type("/protection-history")
      await tui.waitFor("Review where protected values were blocked or redacted", "protection history slash command is missing")
      tui.send(["Enter"])
      await tui.waitFor("All sessions", "protection history dialog did not open")
      await Bun.sleep(120)
      tui.send(["s"])
      await tui.waitFor("This session", "protection history scope toggle did not work")
      await tui.waitFor("Test credential", "protection history did not identify the protected file")
      await tui.waitFor("Sensitive-Protection-Toast", "protection history did not show the triggering session")
      expect(tui.pane()).toContain("~/workspace")
      expect(tui.pane()).not.toContain("TUI_NOTIFY_TOKEN_123")
      tui.send(["Escape"])
      await tui.waitUntil(() => !tui.pane().includes("↑/↓ select"), "protection history did not close")
    } finally {
      await tui.close()
    }
  } finally {
    await e2e.close()
    await rm(root, { recursive: true, force: true })
  }
})
