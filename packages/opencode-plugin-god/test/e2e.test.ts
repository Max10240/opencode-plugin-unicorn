import { expect, setDefaultTimeout, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { createOpenCodeE2E } from "../../opencode-plugin-unicorn/test/e2e-utils.js"
import { api, prompt } from "../../opencode-plugin-show-img/test/e2e-utils.js"

setDefaultTimeout(180_000)

for (const mode of ["standalone", "unicorn"] as const) {
  test(`god replaces the system prompt only for its own agent (${mode})`, async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "god-e2e-"))
    const promptFile = path.join(directory, "prompt.md")
    await writeFile(promptFile, "GOD_SYSTEM_PROMPT_E2E")

    const e2e = await createOpenCodeE2E(
      mode === "standalone"
        ? {
            plugin: "unicorn",
            pluginPackage: path.resolve(import.meta.dir, ".."),
            pluginOptions: { models: { "gpt-5.6-luna": promptFile } },
          }
        : {
            plugin: "unicorn",
            pluginPackage: path.resolve(import.meta.dir, "../../opencode-plugin-unicorn"),
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
                nonBlocking: false,
                opencodeGoUsage: false,
                god: true,
              },
              god: { models: { "gpt-5.6-luna": promptFile } },
            },
          },
    )

    try {
      e2e.proxy.mock.prependFixture({
        match: { userMessage: "E2E_GOD_AGENT", sequenceIndex: 0 },
        response: { content: "GOD_OK" },
      })
      const godSession = await api<{ data: { id: string } }>(e2e, "/api/session", {
        title: "God agent E2E",
        agent: "god",
        model: { providerID: "openai", id: "gpt-5.6-luna" },
        location: { directory: e2e.workspace },
      })
      await prompt(e2e, godSession.data.id, "E2E_GOD_AGENT")
      const godRequest = e2e.proxy.requests.find((request) => JSON.stringify(request.messages).includes("E2E_GOD_AGENT"))
      expect(godRequest).toBeDefined()
      expect(JSON.stringify(godRequest?.messages)).toContain("GOD_SYSTEM_PROMPT_E2E")

      e2e.proxy.mock.prependFixture({
        match: { userMessage: "E2E_GOD_NORMAL", sequenceIndex: 0 },
        response: { content: "NORMAL_OK" },
      })
      const normalSession = await api<{ data: { id: string } }>(e2e, "/api/session", {
        title: "Normal agent E2E",
        agent: "compaction-e2e",
        model: { providerID: "openai", id: "gpt-5.6-luna" },
        location: { directory: e2e.workspace },
      })
      await prompt(e2e, normalSession.data.id, "E2E_GOD_NORMAL")
      const normalRequest = e2e.proxy.requests.find((request) => JSON.stringify(request.messages).includes("E2E_GOD_NORMAL"))
      expect(normalRequest).toBeDefined()
      expect(JSON.stringify(normalRequest?.messages)).not.toContain("GOD_SYSTEM_PROMPT_E2E")
    } finally {
      await e2e.close()
      await rm(directory, { recursive: true, force: true })
    }
  })
}
