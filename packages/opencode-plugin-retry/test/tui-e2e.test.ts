import { expect, setDefaultTimeout, test } from "bun:test"
import { writeFile } from "node:fs/promises"
import path from "node:path"
import { createOpenCodeE2E } from "../../opencode-plugin-unicorn/test/e2e-utils.js"
import { api, createSession } from "../../opencode-plugin-show-img/test/e2e-utils.js"
import { createTui } from "../../../test/tui-support.js"

setDefaultTimeout(180_000)

const PACKAGE_ROOT = path.resolve(import.meta.dir, "../../opencode-plugin-unicorn")
const baseFeatures = {
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
  infiniteLoop: false,
  delayedQueue: false,
  retry: true,
}
const baseRetry = { keybind: "f5", continueText: "Continue" }
type E2E = Awaited<ReturnType<typeof createOpenCodeE2E>>

async function start(input: { retry?: Record<string, unknown>; features?: Record<string, boolean> } = {}) {
  const features = { ...baseFeatures, ...input.features }
  const retry = { ...baseRetry, ...input.retry }
  const e2e = await createOpenCodeE2E({
    plugin: "unicorn",
    pluginPackage: PACKAGE_ROOT,
    pluginOptions: { features, retry },
  })
  await e2e.waitForModelContext(200_000)
  await writeFile(path.join(e2e.configDirectory, "cli.json"), `${JSON.stringify({
    plugins: [{ package: PACKAGE_ROOT, options: { features, retry } }],
    keybinds: { "command.palette.show": "f10" },
  }, null, 2)}\n`)
  return e2e
}

async function open(e2e: E2E, title: string, name: string) {
  const sessionID = await createSession(e2e, title)
  const tui = createTui(e2e, sessionID, name, { width: 160, height: 48 })
  try {
    await tui.waitFor(title, "the TUI did not start")
    await Bun.sleep(1_000)
    // The composer commits its selected agent and model on submit. Wait for the session's values
    // to hydrate so a loaded machine cannot submit with the TUI fallback model.
    await tui.waitFor("Compaction-E2e · GPT-5.6 Luna", "session agent and model did not settle", 30_000)
  } catch (error) {
    tui.close()
    throw error
  }
  return { sessionID, tui }
}

async function userTexts(e2e: E2E, sessionID: string) {
  const exported = await api<{ data: { messages: Array<Record<string, any>> } }>(e2e, `/api/experimental/session/${sessionID}/export`)
  return exported.data.messages
    .filter((message) => message.type === "user")
    .flatMap((message) => typeof message.text === "string" ? [message.text] : [])
}

test.serial("F5 and /retry interrupt a running turn, then send Continue while idle", async () => {
  if (Bun.spawnSync(["tmux", "-V"]).exitCode !== 0) throw new Error("tmux is required for this E2E test")
  const e2e = await start()
  try {
    e2e.proxy.mock.prependFixture({
      match: { userMessage: "E2E_RETRY_BUSY", sequenceIndex: 0 },
      response: { content: "RETRY_BUSY_LATE" },
      latency: 15_000,
    })
    e2e.proxy.mock.prependFixture({ match: { userMessage: "Continue", sequenceIndex: 0 }, response: { content: "RETRY_CONTINUE_OK" } })
    e2e.proxy.mock.prependFixture({ match: { userMessage: "Continue", sequenceIndex: 1 }, response: { content: "RETRY_IDLE_OK" } })
    e2e.proxy.mock.prependFixture({ match: { userMessage: "Continue", sequenceIndex: 2 }, response: { content: "RETRY_SLASH_OK" } })

    const { sessionID, tui } = await open(e2e, "Retry-TUI-E2E", "retry-tui")
    try {
      tui.type("E2E_RETRY_BUSY")
      tui.send(["Enter"])
      await tui.waitFor("esc interrupt", "the busy turn did not start", 20_000)
      tui.send(["F5"])
      await tui.waitFor("RETRY_CONTINUE_OK", "Continue did not run after the interrupt", 20_000)
      await tui.waitFor("Continue", "the Continue prompt was not sent")
      expect(tui.pane()).not.toContain("Retry with Continue")

      tui.send(["F5"])
      await tui.waitFor("RETRY_IDLE_OK", "idle F5 did not send Continue", 20_000)

      tui.type("/retry ")
      tui.send(["Enter"])
      await tui.waitFor("RETRY_SLASH_OK", "/retry did not send Continue while idle", 20_000)

      const texts = await userTexts(e2e, sessionID)
      expect(texts).toContain("E2E_RETRY_BUSY")
      expect(texts.filter((text) => text === "Continue")).toHaveLength(3)
    } finally {
      tui.close()
    }
  } finally {
    await e2e.close()
  }
})

test.serial("F5 is ignored while the command palette is open", async () => {
  if (Bun.spawnSync(["tmux", "-V"]).exitCode !== 0) throw new Error("tmux is required for this E2E test")
  const e2e = await start()
  try {
    e2e.proxy.mock.prependFixture({ match: { userMessage: "Continue", sequenceIndex: 0 }, response: { content: "UNEXPECTED_CONTINUE" } })
    const { sessionID, tui } = await open(e2e, "Retry-Modal-E2E", "retry-modal")
    try {
      tui.send(["F10"])
      await tui.waitFor("Commands", "the command palette did not open")
      tui.send(["F5"])
      await Bun.sleep(1_000)
      expect(tui.pane()).not.toContain("UNEXPECTED_CONTINUE")
      expect(await userTexts(e2e, sessionID)).not.toContain("Continue")
      tui.send(["Escape"])
      await tui.waitUntil(() => !tui.pane().includes("Commands"), "the command palette did not close")
    } finally {
      tui.close()
    }
  } finally {
    await e2e.close()
  }
})

test.serial("F5 leaves the composer draft intact and sends Continue", async () => {
  if (Bun.spawnSync(["tmux", "-V"]).exitCode !== 0) throw new Error("tmux is required for this E2E test")
  const e2e = await start()
  try {
    e2e.proxy.mock.prependFixture({ match: { userMessage: "Continue", sequenceIndex: 0 }, response: { content: "DRAFT_CONTINUE_OK" } })
    const { sessionID, tui } = await open(e2e, "Retry-Draft-E2E", "retry-draft")
    try {
      tui.type("DRAFT_TEXT")
      await tui.waitFor("DRAFT_TEXT", "the draft did not appear")
      tui.send(["F5"])
      await tui.waitFor("DRAFT_CONTINUE_OK", "Continue did not run with a draft present", 20_000)
      expect(tui.pane()).toContain("DRAFT_TEXT")
      const texts = await userTexts(e2e, sessionID)
      expect(texts).toContain("Continue")
      expect(texts).not.toContain("DRAFT_TEXT")
    } finally {
      tui.close()
    }
  } finally {
    await e2e.close()
  }
})

test.serial("keybind false keeps slash only and uses the configured Continue text", async () => {
  if (Bun.spawnSync(["tmux", "-V"]).exitCode !== 0) throw new Error("tmux is required for this E2E test")
  const e2e = await start({ retry: { keybind: false, continueText: "Keep going" } })
  try {
    e2e.proxy.mock.prependFixture({ match: { userMessage: "Keep going", sequenceIndex: 0 }, response: { content: "CUSTOM_CONTINUE_OK" } })
    const { sessionID, tui } = await open(e2e, "Retry-Slash-E2E", "retry-slash")
    try {
      tui.send(["F5"])
      await Bun.sleep(500)
      expect(await userTexts(e2e, sessionID)).not.toContain("Keep going")

      tui.type("/retry ")
      tui.send(["Enter"])
      await tui.waitFor("CUSTOM_CONTINUE_OK", "the slash command did not use the configured Continue text", 20_000)
      expect(await userTexts(e2e, sessionID)).toContain("Keep going")
    } finally {
      tui.close()
    }
  } finally {
    await e2e.close()
  }
})

test.serial("the feature switch leaves F5 unbound", async () => {
  if (Bun.spawnSync(["tmux", "-V"]).exitCode !== 0) throw new Error("tmux is required for this E2E test")
  const e2e = await start({ features: { retry: false } })
  try {
    e2e.proxy.mock.prependFixture({ match: { userMessage: "Continue", sequenceIndex: 0 }, response: { content: "UNEXPECTED_CONTINUE" } })
    const { sessionID, tui } = await open(e2e, "Retry-Disabled-E2E", "retry-disabled")
    try {
      tui.send(["F5"])
      await Bun.sleep(1_000)
      expect(tui.pane()).not.toContain("UNEXPECTED_CONTINUE")
      expect(await userTexts(e2e, sessionID)).not.toContain("Continue")
    } finally {
      tui.close()
    }
  } finally {
    await e2e.close()
  }
})
