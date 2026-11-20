import { expect, setDefaultTimeout, test } from "bun:test"
import { writeFile } from "node:fs/promises"
import path from "node:path"
import { createOpenCodeE2E } from "../../opencode-plugin-unicorn/test/e2e-utils.js"
import { api, createSession } from "../../opencode-plugin-show-img/test/e2e-utils.js"
import { createTui } from "../../../test/tui-support.js"

setDefaultTimeout(180_000)

const PACKAGE_ROOT = path.resolve(import.meta.dir, "..")

async function start() {
  const e2e = await createOpenCodeE2E({
    plugin: "unicorn",
    pluginPackage: PACKAGE_ROOT,
    pluginOptions: { recheckMs: 1_000 },
  })
  await e2e.waitForModelContext(200_000)
  await writeFile(path.join(e2e.configDirectory, "cli.json"), `${JSON.stringify({
    plugins: [{ package: PACKAGE_ROOT, options: { recheckMs: 1_000 } }],
    keybinds: { "command.palette.show": "f10" },
  }, null, 2)}\n`)
  return e2e
}

async function text(e2e: Awaited<ReturnType<typeof start>>, sessionID: string) {
  const exported = await api<{ data: { messages: Array<Record<string, any>> } }>(e2e, `/api/experimental/session/${sessionID}/export`)
  return exported.data.messages
    .filter((message) => message.type === "user")
    .flatMap((message) => {
      if (typeof message.text === "string") return [message.text]
      return Array.isArray(message.content)
        ? message.content.filter((part: Record<string, any>) => part.type === "text").map((part: any) => part.text as string)
        : []
    })
}


async function queueDelayed(tui: ReturnType<typeof createTui>, text: string, expected: number) {
  tui.type(text)
  await Bun.sleep(150)
  tui.send(["F9"])
  await tui.waitFor(`${expected} delayed`, "pending bar did not appear")
}


async function submitPrompt(tui: ReturnType<typeof createTui>, marker: string) {
  tui.send(["Enter"])
  try {
    await tui.waitFor(marker, `prompt did not finish: ${marker}`, 5_000)
  } catch {
    tui.send(["Enter"])
    await tui.waitFor(marker, `prompt did not finish after retry: ${marker}`, 30_000)
  }
}

async function readyTui(tui: ReturnType<typeof createTui>, title: string) {
  await tui.waitFor(title, "TUI did not start")
  await Bun.sleep(600)
  if (tui.pane().includes("Connect an integration")) {
    tui.send(["Escape"])
    await tui.waitUntil(() => !tui.pane().includes("Connect an integration"), "integration dialog did not close", 5_000)
    await Bun.sleep(250)
  }
}

function fixture(e2e: Awaited<ReturnType<typeof start>>, userMessage: string | RegExp, content: string) {
  e2e.proxy.mock.prependFixture({ match: { userMessage }, response: { content } })
}

async function delayedStatus(e2e: Awaited<ReturnType<typeof start>>, sessionID: string) {
  const query = `?location[directory]=${encodeURIComponent(e2e.workspace)}`
  return (await api<{ output?: Record<string, unknown> }>(e2e, `/api/rpc/max10240.delayed-queue/status${query}`, { input: { sessionID } })).output
}

test("shows the pending bar and delivers the delayed message after the turn", async () => {
  const e2e = await start()
  const sessionID = await createSession(e2e, "Delayed-Queue-TUI")
  const tui = createTui(e2e, sessionID, "delayed-queue", { width: 180, height: 48 })
  try {
    await readyTui(tui, "Delayed-Queue-TUI")
    e2e.proxy.mock.prependFixture({
      match: { userMessage: "E2E_DQ_TUI_BEGIN", sequenceIndex: 0 },
      response: { content: "BEGIN_TUI_OK" },
      latency: 3_000,
    })
    fixture(e2e, "E2E_DQ_TUI_DELAYED", "DELAYED_TUI_OK")

    tui.type("E2E_DQ_TUI_BEGIN")
    tui.send(["Enter"])
    await Bun.sleep(400)
    await queueDelayed(tui, "E2E_DQ_TUI_DELAYED", 1)
    await tui.waitFor("BEGIN_TUI_OK", "first turn did not finish", 15_000)
    await tui.waitFor("E2E_DQ_TUI_DELAYED", "pending text did not appear")
    await tui.waitFor("DELAYED_TUI_OK", "delayed message was not delivered", 20_000)
    await tui.waitUntil(() => !tui.pane().includes("1 delayed"), "pending bar did not clear")
    const final = await delayedStatus(e2e, sessionID)
    expect(final?.items).toEqual([])
    expect(final?.observed).toBe(true)
    expect((await text(e2e, sessionID)).includes("E2E_DQ_TUI_DELAYED")).toBe(true)
  } finally {
    await tui.close()
    await e2e.close()
  }
})

test("opens the management panel and deletes one pending message", async () => {
  const e2e = await start()
  const sessionID = await createSession(e2e, "Delayed-Queue-Panel")
  const tui = createTui(e2e, sessionID, "delayed-queue-panel", { width: 180, height: 48 })
  try {
    await readyTui(tui, "Delayed-Queue-Panel")
    e2e.proxy.mock.prependFixture({
      match: { userMessage: "E2E_DQ_PANEL_BEGIN", sequenceIndex: 0 },
      response: { content: "PANEL_BEGIN_OK" },
      latency: 4_000,
    })
    fixture(e2e, "E2E_DQ_PANEL_KEEP", "PANEL_KEEP_OK")

    tui.type("E2E_DQ_PANEL_BEGIN")
    tui.send(["Enter"])
    await Bun.sleep(400)
    await queueDelayed(tui, "E2E_DQ_PANEL_DELETE", 1)
    await queueDelayed(tui, "E2E_DQ_PANEL_KEEP", 2)

    tui.send(["C-x", "d"])
    await tui.waitFor("Delayed prompts", "management panel did not open")
    tui.send(["d"])
    await tui.waitFor("1 of 1", "panel did not update after delete")
    tui.send(["Escape"])
    await tui.waitFor("1 delayed", "deleted message was not removed from the dock")

    await tui.waitFor("PANEL_KEEP_OK", "remaining message was not delivered", 20_000)
    expect(tui.pane()).not.toContain("PANEL_DELETE_SHOULD_NOT_RUN")
  } finally {
    await tui.close()
    await e2e.close()
  }
})

test("waits for a background shell before delivering in the TUI", async () => {
  const e2e = await start()
  const sessionID = await createSession(e2e, "Delayed-Queue-Background-TUI")
  const tui = createTui(e2e, sessionID, "delayed-queue-background", { width: 180, height: 48 })
  try {
    await readyTui(tui, "Delayed-Queue-Background-TUI")
    e2e.proxy.mock.prependFixture({
      match: { userMessage: "E2E_DQ_TUI_BG", sequenceIndex: 0 },
      response: {
        toolCalls: [
          {
            id: "call_tui_bg",
            name: "shell",
            arguments: JSON.stringify({ command: "sleep 4; echo TUI_BG_DONE", background: true }),
          },
        ],
      },
    })
    e2e.proxy.mock.prependFixture({ match: { toolCallId: "call_tui_bg" }, response: { content: "TUI_BG_STARTED" } })
    e2e.proxy.mock.prependFixture({ match: { userMessage: /TUI_BG_DONE/ }, response: { content: "TUI_BG_NOTICE" } })
    fixture(e2e, "E2E_DQ_TUI_BG_DELAYED", "TUI_BG_DELIVERED")

    tui.type("E2E_DQ_TUI_BG")
    await submitPrompt(tui, "TUI_BG_STARTED")
    await queueDelayed(tui, "E2E_DQ_TUI_BG_DELAYED", 1)
    await Bun.sleep(2_000)
    expect(tui.pane()).not.toContain("TUI_BG_DELIVERED")
    await tui.waitFor("TUI_BG_DELIVERED", "delayed message did not wait for the shell", 20_000)
  } finally {
    await tui.close()
    await e2e.close()
  }
})

test("pauses after manual interrupt and resumes after the next prompt", async () => {
  const e2e = await start()
  const sessionID = await createSession(e2e, "Delayed-Queue-Interrupt-TUI")
  const tui = createTui(e2e, sessionID, "delayed-queue-interrupt", { width: 180, height: 48 })
  try {
    await readyTui(tui, "Delayed-Queue-Interrupt-TUI")
    e2e.proxy.mock.prependFixture({
      match: { userMessage: "E2E_DQ_TUI_INTERRUPT", sequenceIndex: 0 },
      response: { content: "INTERRUPT_LATE" },
      latency: 10_000,
    })
    fixture(e2e, "E2E_DQ_TUI_RESUME", "RESUME_TUI_OK")
    fixture(e2e, "E2E_DQ_TUI_INTERRUPT_DELIVERED", "INTERRUPT_TUI_DELIVERED")

    tui.type("E2E_DQ_TUI_INTERRUPT")
    tui.send(["Enter"])
    await Bun.sleep(400)
    await queueDelayed(tui, "E2E_DQ_TUI_INTERRUPT_DELIVERED", 1)
    tui.send(["Escape"])
    await Bun.sleep(150)
    tui.send(["Escape"])
    await tui.waitFor("paused", "queue did not pause after the interrupt", 10_000)

    tui.type("E2E_DQ_TUI_RESUME")
    await submitPrompt(tui, "RESUME_TUI_OK")
    await tui.waitFor("INTERRUPT_TUI_DELIVERED", "delayed message did not resume", 20_000)
  } finally {
    await tui.close()
    await e2e.close()
  }
})
