import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test"
import { writeFile } from "node:fs/promises"
import path from "node:path"
import { createOpenCodeE2E } from "../../opencode-plugin-unicorn/test/e2e-utils.js"
import { api, createSession } from "../../opencode-plugin-show-img/test/e2e-utils.js"
import { createTui } from "../../../test/tui-support.js"

setDefaultTimeout(180_000)

const PACKAGE_ROOT = path.resolve(import.meta.dir, "..")
let e2e: Awaited<ReturnType<typeof createOpenCodeE2E>>

function cliConfig(paletteKeybind: string) {
  return `${JSON.stringify({
    plugins: [{ package: PACKAGE_ROOT, options: { recheckMs: 1_000 } }],
    keybinds: { "command.palette.show": paletteKeybind },
  }, null, 2)}\n`
}

beforeAll(async () => {
  e2e = await createOpenCodeE2E({
    plugin: "unicorn",
    pluginPackage: PACKAGE_ROOT,
    pluginOptions: { recheckMs: 1_000 },
  })
  await e2e.waitForModelContext(200_000)
  await writeFile(path.join(e2e.configDirectory, "cli.json"), cliConfig("f10"))
})

afterAll(async () => {
  await e2e?.close()
})

async function text(e2e: Awaited<ReturnType<typeof createOpenCodeE2E>>, sessionID: string) {
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
  // F9 reads the focused composer, but focus can move while a turn runs. If the composer was not
  // read, the plugin opens its prompt dialog; fill that so the message is never silently dropped.
  await tui.waitUntil(
    () => tui.pane().includes("Queue delayed message") || tui.pane().includes(`${expected} delayed`),
    "the queue action neither opened its prompt nor queued the message",
  )
  if (tui.pane().includes("Queue delayed message")) {
    tui.type(text)
    await tui.waitFor(text, "queue prompt did not receive the text")
    tui.send(["Enter"])
  }
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
  // The composer commits its selected agent and model on submit. Wait for the session's values
  // to hydrate so a loaded machine cannot submit with the TUI fallback model.
  await tui.waitFor("Compaction-E2e · GPT-5.6 Luna", "session agent and model did not settle", 30_000)
}

function fixture(e2e: Awaited<ReturnType<typeof createOpenCodeE2E>>, userMessage: string | RegExp, content: string) {
  e2e.proxy.mock.prependFixture({ match: { userMessage }, response: { content } })
}

async function delayedStatus(e2e: Awaited<ReturnType<typeof createOpenCodeE2E>>, sessionID: string) {
  const query = `?location[directory]=${encodeURIComponent(e2e.workspace)}`
  return (await api<{ output?: Record<string, unknown> }>(e2e, `/api/rpc/max10240.delayed-queue/status${query}`, { input: { sessionID } })).output
}

test("shows the pending bar and delivers the delayed message after the turn", async () => {
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
    await tui.waitFor("esc interrupt", "the holding turn did not start", 20_000)
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
  }
})

test("opens the management panel and deletes one pending message", async () => {
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
    await tui.waitFor("esc interrupt", "the holding turn did not start", 20_000)
    await queueDelayed(tui, "E2E_DQ_PANEL_DELETE", 1)
    await queueDelayed(tui, "E2E_DQ_PANEL_KEEP", 2)

    tui.send(["C-x", "d"])
    await tui.waitFor("Delayed prompts", "management panel did not open")
    // Typing action letters filters the list instead of steering or deleting.
    tui.type("d")
    await Bun.sleep(300)
    expect(tui.pane()).toContain("Delayed prompts")
    expect(tui.pane()).not.toContain("Delayed prompt sent")
    tui.send(["BSpace"])
    tui.send(["C-d"])
    await tui.waitFor("1 of 1", "panel did not update after one delete")
    await tui.waitFor("▶ E2E_DQ_PANEL_KEEP", "selection did not move to the next prompt")
    expect(tui.pane()).not.toContain("Press ctrl+d again")
    expect(tui.pane()).not.toContain("Delayed prompt deleted")
    tui.send(["Escape"])
    await tui.waitFor("1 delayed", "deleted message was not removed from the dock")

    await tui.waitFor("PANEL_KEEP_OK", "remaining message was not delivered", 20_000)
    expect(tui.pane()).not.toContain("PANEL_DELETE_SHOULD_NOT_RUN")
  } finally {
    await tui.close()
  }
})

test("ctrl+p pauses the whole queue without opening the command palette", async () => {
  let tui: ReturnType<typeof createTui> | undefined
  try {
    await writeFile(path.join(e2e.configDirectory, "cli.json"), cliConfig("ctrl+p"))
    const sessionID = await createSession(e2e, "Delayed-Queue-Pause")
    const ui = createTui(e2e, sessionID, "delayed-queue-pause", { width: 180, height: 48 })
    tui = ui
    await readyTui(ui, "Delayed-Queue-Pause")
    e2e.proxy.mock.prependFixture({
      match: { userMessage: "E2E_DQ_PAUSE_BEGIN", sequenceIndex: 0 },
      response: { content: "PAUSE_BEGIN_OK" },
      latency: 8_000,
    })
    fixture(e2e, "E2E_DQ_PAUSE_HELD", "PAUSE_HELD_OK")
    ui.type("E2E_DQ_PAUSE_BEGIN")
    ui.send(["Enter"])
    await ui.waitFor("esc interrupt", "the holding turn did not start", 20_000)
    await queueDelayed(ui, "E2E_DQ_PAUSE_HELD", 1)

    ui.send(["C-x", "d"])
    await ui.waitFor("Delayed prompts", "management panel did not open")
    ui.send(["C-p"])
    await ui.waitFor("Whole queue paused", "ctrl+p did not pause the queue")
    expect(ui.pane()).not.toContain("Commands")
    expect(ui.pane()).toContain("ctrl+p resume queue")
    expect((await delayedStatus(e2e, sessionID))?.paused).toBe(true)

    ui.send(["C-p"])
    await ui.waitFor("ctrl+p pause queue", "ctrl+p did not resume the queue")
    expect(ui.pane()).not.toContain("Whole queue paused")
    expect((await delayedStatus(e2e, sessionID))?.paused).toBe(false)
  } finally {
    try {
      await tui?.close()
    } finally {
      await writeFile(path.join(e2e.configDirectory, "cli.json"), cliConfig("f10"))
    }
  }
})

test("deleting the last pending message closes the panel", async () => {
  const sessionID = await createSession(e2e, "Delayed-Queue-Delete-Last")
  const tui = createTui(e2e, sessionID, "delayed-queue-delete-last", { width: 180, height: 48 })
  try {
    await readyTui(tui, "Delayed-Queue-Delete-Last")
    e2e.proxy.mock.prependFixture({
      match: { userMessage: "E2E_DQ_LAST_BEGIN", sequenceIndex: 0 },
      response: { content: "LAST_BEGIN_OK" },
      latency: 5_000,
    })
    tui.type("E2E_DQ_LAST_BEGIN")
    tui.send(["Enter"])
    await tui.waitFor("esc interrupt", "the holding turn did not start", 20_000)
    await queueDelayed(tui, "E2E_DQ_LAST_DELETE", 1)

    tui.send(["C-x", "d"])
    await tui.waitFor("Delayed prompts", "management panel did not open")
    tui.send(["C-d"])
    await tui.waitUntil(() => !tui.pane().includes("Delayed prompts"), "panel did not close after deleting the last prompt", 5_000)
    expect(tui.pane()).not.toContain("1 delayed")

    await tui.waitFor("LAST_BEGIN_OK", "the holding turn did not finish", 20_000)
    expect((await text(e2e, sessionID)).includes("E2E_DQ_LAST_DELETE")).toBe(false)
  } finally {
    await tui.close()
  }
})

test("waits for a background shell before delivering in the TUI", async () => {
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
  }
})

test("pauses after manual interrupt and resumes after the next prompt", async () => {
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
    await tui.waitFor("esc interrupt", "the holding turn did not start", 20_000)
    await queueDelayed(tui, "E2E_DQ_TUI_INTERRUPT_DELIVERED", 1)
    tui.send(["Escape"])
    await Bun.sleep(150)
    tui.send(["Escape"])
    await tui.waitFor("paused", "queue did not pause after the interrupt", 10_000)
    // "paused" is emitted when the interrupt is accepted; wait for cleanup to settle before
    // submitting the resume prompt so it cannot race the stopping turn.
    await api(e2e, `/api/experimental/session/${sessionID}/wait`, {})

    tui.type("E2E_DQ_TUI_RESUME")
    await submitPrompt(tui, "RESUME_TUI_OK")
    await tui.waitFor("INTERRUPT_TUI_DELIVERED", "delayed message did not resume", 20_000)
  } finally {
    await tui.close()
  }
})
