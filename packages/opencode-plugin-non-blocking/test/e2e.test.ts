import { expect, setDefaultTimeout, test } from "bun:test"
import { writeFile } from "node:fs/promises"
import path from "node:path"
import { createOpenCodeE2E } from "../../opencode-plugin-unicorn/test/e2e-utils.js"
import { api, createSession, prompt, waitFor } from "../../opencode-plugin-show-img/test/e2e-utils.js"
import { createTui } from "../../../test/tui-support.js"

setDefaultTimeout(180_000)

test("backgrounds a shell that exceeds the configured threshold", async () => {
  const pluginPackage = path.resolve(import.meta.dir, "../../opencode-plugin-unicorn")
  const e2e = await createOpenCodeE2E({
    plugin: "unicorn",
    pluginPackage: path.resolve(pluginPackage, "dist"),
    pluginOptions: {
      features: {
        recommendedOpencodeConfig: false,
        sendMessageAcrossSessions: false,
        imageGen: false,
        notepad: false,
        showImg: false,
        promptSearch: false,
        sessionSearch: false,
        sensitiveEncrypt: false,
        sensitiveProtection: false,
        nonBlocking: true,
      },
    },
  })
  try {
    const sessionID = await createSession(e2e, "Non-Blocking-E2E")
    await writeFile(path.join(e2e.configDirectory, "cli.json"), `${JSON.stringify({
      plugins: [{
        package: pluginPackage,
        options: {
          features: {
            recommendedOpencodeConfig: false,
            sendMessageAcrossSessions: false,
            imageGen: false,
            notepad: false,
            showImg: false,
            promptSearch: false,
            sessionSearch: false,
            sensitiveEncrypt: false,
            sensitiveProtection: false,
            nonBlocking: true,
          },
          nonBlocking: { thresholdMs: 1_500 },
        },
      }],
    }, null, 2)}\n`)

    const tui = createTui(e2e, sessionID, "non-blocking")
    try {
      await tui.waitFor("Non-Blocking-E2E", "non-blocking TUI did not start")
      e2e.proxy.mock.prependFixture({
        match: { userMessage: "E2E_NON_BLOCKING_SHELL", sequenceIndex: 0 },
        response: {
          toolCalls: [{
            id: "call_non_blocking_shell",
            name: "shell",
            arguments: JSON.stringify({ command: "sleep 3" }),
          }],
        },
      })
      e2e.proxy.mock.prependFixture({ match: { toolCallId: "call_non_blocking_shell" }, response: { content: "SHELL_BACKGROUNDED" } })
      await prompt(e2e, sessionID, "E2E_NON_BLOCKING_SHELL")
      await waitFor(async () => {
        const exported = await api<{ data: { messages: Array<Record<string, any>> } }>(e2e, `/api/experimental/session/${sessionID}/export`)
        const tool = exported.data.messages.flatMap((message) => message.content ?? []).find((part) => part.type === "tool" && part.name === "shell")
        return tool?.state.status === "completed" && tool.state.metadata?.status === "running"
      }, "long shell was not moved to the background", 10_000)
    } finally {
      await tui.close()
    }
  } finally {
    await e2e.close()
  }
})
