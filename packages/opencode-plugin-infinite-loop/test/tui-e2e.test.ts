import { expect, setDefaultTimeout, test } from "bun:test"
import { mkdir, realpath } from "node:fs/promises"
import path from "node:path"
import { createOpenCodeE2E } from "../../opencode-plugin-unicorn/test/e2e-utils.js"
import { api, createSession, prompt, waitFor } from "../../opencode-plugin-show-img/test/e2e-utils.js"
import { createTui } from "../../../test/tui-support.js"
import { DEFAULT_MESSAGE } from "../src/options.js"

setDefaultTimeout(300_000)

const RPC = "max10240.infinite-loop"
const PACKAGE_ROOT = path.resolve(import.meta.dir, "..")

type E2E = Awaited<ReturnType<typeof createOpenCodeE2E>>
type Status = { active?: boolean; sentCount?: number; phase?: string; outcome?: { reason: string } }

async function rpcStatus(e2e: E2E, sessionID: string): Promise<Status> {
  // The TUI resolves its cwd through the /var -> /private/var symlink. The unqualified
  // RPC reaches the shared runtime regardless of which location instance started it.
  const response = await api<{ output?: Status }>(e2e, `/api/rpc/${RPC}/status`, { input: { sessionID } })
  return response.output ?? {}
}

async function rpcStart(e2e: E2E, sessionID: string, durationMs: number, cooldownMs?: number): Promise<void> {
  const directories = [await realpath(e2e.workspace), e2e.workspace]
  const queries = [...directories.map((directory) => `?location[directory]=${encodeURIComponent(directory)}`), ""]
  for (const query of queries) {
    try {
      await api(e2e, `/api/rpc/${RPC}/start${query}`, {
        input: { sessionID, durationMs, ...(cooldownMs === undefined ? {} : { cooldownMs }) },
      })
      return
    } catch {
      // Try the next location form.
    }
  }
  throw new Error(`Infinite loop start RPC is unavailable for ${sessionID}`)
}

test.serial("panel takes custom durations and cooldowns, keeps nudging, and stops on request", async () => {
  if (Bun.spawnSync(["tmux", "-V"]).exitCode !== 0) throw new Error("tmux is required for this E2E test")
  const e2e = await createOpenCodeE2E({
    plugin: "unicorn",
    pluginPackage: PACKAGE_ROOT,
    pluginOptions: {
      delayMs: 300,
      recheckMs: 500,
      cooldownMs: 2_000,
      minDurationMs: 1_000,
      maxDurationMs: 30 * 24 * 60 * 60_000,
    },
  })
  try {
    e2e.proxy.mock.prependFixture({
      match: { userMessage: "E2E_INFINITELOOP_TUI", sequenceIndex: 0 },
      response: { content: "E2E_TUI_OK" },
    })
    e2e.proxy.mock.prependFixture({
      match: { userMessage: DEFAULT_MESSAGE },
      response: { content: "NUDGE_ACK" },
    })

    const sessionID = await createSession(e2e, "Infinite-Loop-TUI-E2E")
    await prompt(e2e, sessionID, "E2E_INFINITELOOP_TUI")
    const tui = createTui(e2e, sessionID, "infinite-loop-tui", { height: 52 })
    try {
      await tui.waitFor("Infinite-Loop-TUI-E2E", "the TUI did not start")
      // TUI plugins register asynchronously after the session renders.
      await Bun.sleep(1_000)

      // An arguments-style slash dispatches on submit: "/infinite-loop 90m cooldown=3m" starts directly.
      // Toasts are short-lived, so assert the registered task instead of the toast text.
      tui.type("/infinite-loop 90m cooldown=3m")
      tui.send(["Enter"])
      await waitFor(
        async () => (await rpcStatus(e2e, sessionID)).active === true,
        "the slash start did not register a loop",
        15_000,
      )
      await tui.waitFor("∞ LOOP", "the footer loop badge is missing", 15_000)

      // "/infinite-loop " submits with an empty argument and opens the panel.
      tui.type("/infinite-loop ")
      tui.send(["Enter"])
      await tui.waitFor("Running · sent", "the panel did not open")
      await tui.waitFor("This session", "the current-session section is missing")
      await tui.waitFor("[1] 15m", "the presets row is missing")

      // The loop nudges while the panel is open; the cooldown is two seconds.
      await waitFor(
        async () => ((await rpcStatus(e2e, sessionID)).sentCount ?? 0) >= 1,
        "the loop did not send its first nudge",
        20_000,
      )
      await tui.waitFor("Running · sent", "the panel did not show the running status")

      // Focus order is duration -> cooldown -> presets; d on the presets row stops the loop.
      tui.send(["Tab"])
      tui.send(["Tab"])
      tui.send(["d"])
      await tui.waitFor("Infinite loop stopped", "stop did not run from the presets row")
      await tui.waitFor("Stopped at", "the stopped outcome is missing")

      // Typing "24h" in the duration input: digits must never trigger a preset.
      tui.send(["Tab"])
      tui.type("24h")
      await tui.waitFor("= 1d", "the custom duration preview is missing")
      await tui.waitUntil(() => !tui.pane().includes("Running · sent"), "a preset fired while typing a custom duration")

      // The cooldown input accepts unit suffixes; use seconds to keep the E2E fast.
      tui.send(["Tab"])
      tui.type("3s")
      await tui.waitFor("= 3s", "the cooldown preview is missing")

      // Enter on the cooldown input starts the typed duration and cooldown.
      tui.send(["Enter"])
      await tui.waitFor("Infinite loop started · runs for 1d · cooldown 3s", "the custom start did not run")

      // The idle session is nudged again after the cooldown, not immediately.
      await waitFor(
        async () => ((await rpcStatus(e2e, sessionID)).sentCount ?? 0) >= 2,
        "the loop did not repeat after the cooldown",
        30_000,
      )

      // A digit on the presets row quick-starts that preset (the third preset is 2h).
      tui.send(["Tab"])
      tui.send(["3"])
      await tui.waitFor("Infinite loop started · runs for 2h", "the preset digit did not quick-start")

      // Leave the session clean.
      tui.send(["d"])
      await tui.waitFor("Infinite loop stopped", "the cleanup stop did not run")
      expect((await rpcStatus(e2e, sessionID)).active).toBe(false)
    } finally {
      tui.close()
    }
  } finally {
    await e2e.close()
  }
})

test.serial("all-projects panel lists and stops loops from another directory", async () => {
  if (Bun.spawnSync(["tmux", "-V"]).exitCode !== 0) throw new Error("tmux is required for this E2E test")
  const e2e = await createOpenCodeE2E({
    plugin: "unicorn",
    pluginPackage: PACKAGE_ROOT,
    pluginOptions: {
      delayMs: 300,
      recheckMs: 500,
      cooldownMs: 0,
      minDurationMs: 1_000,
      maxDurationMs: 30 * 24 * 60 * 60_000,
    },
  })
  try {
    e2e.proxy.mock.prependFixture({
      match: { userMessage: "E2E_ALL_PROJECTS", sequenceIndex: 0 },
      response: { content: "E2E_ALL_OK" },
    })
    e2e.proxy.mock.prependFixture({
      match: { userMessage: DEFAULT_MESSAGE },
      response: { content: "NUDGE_ACK" },
    })

    const first = await createSession(e2e, "Infinite-Loop-All-A")
    await prompt(e2e, first, "E2E_ALL_PROJECTS")
    const secondWorkspace = path.join(e2e.root, "workspace-b")
    await mkdir(secondWorkspace, { recursive: true })
    const secondSession = await api<{ data: { id: string } }>(e2e, "/api/session", {
      title: "Infinite-Loop-All-B",
      agent: "compaction-e2e",
      model: { providerID: "openai", id: "gpt-5.6-luna" },
      location: { directory: secondWorkspace },
    })
    const second = secondSession.data.id

    // The TUI connection loads the server plugin. Start it before issuing RPCs directly.
    const tui = createTui(e2e, first, "infinite-loop-all", { height: 52 })
    try {
      await tui.waitFor("Infinite-Loop-All-A", "the TUI did not start")
      await Bun.sleep(1_000)
      await rpcStart(e2e, first, 60_000)
      await rpcStart(e2e, second, 60_000)
      await waitFor(
        async () => (await rpcStatus(e2e, first)).active === true && (await rpcStatus(e2e, second)).active === true,
        "both loops did not start",
      )

      // The trailing space accepts the no-argument slash completion before submit.
      tui.type("/infinite-loops ")
      tui.send(["Enter"])
      await tui.waitFor("Infinite loops · 2 running", "the all-projects panel did not show both loops")
      await tui.waitFor("All projects", "the all-projects subtitle is missing")
      await tui.waitFor("Infinite-Loop-All-A", "the first loop is missing")
      await tui.waitFor("Infinite-Loop-All-B", "the second loop is missing")
      await tui.waitFor("workspace-b", "the second directory is missing")
      await tui.waitFor("(current)", "the current-session marker is missing")

      // The first row is the current session in this fixture; d stops it.
      tui.send(["d"])
      await tui.waitFor("Infinite loop stopped", "the selected loop did not stop")
      await waitFor(async () => (await rpcStatus(e2e, first)).active === false, "the first loop is still active", 10_000)
      await tui.waitFor("Infinite loops · 1 running", "the header did not drop to one loop")

      // Stop the remaining loop from the same panel.
      tui.send(["d"])
      await tui.waitFor("Infinite loop stopped", "the remaining loop did not stop")
      await waitFor(async () => (await rpcStatus(e2e, second)).active === false, "the second loop is still active", 10_000)
      await tui.waitFor("No running loops", "the empty all-projects state is missing")

      // ctrl+a returns to the current-session view.
      tui.send(["C-a"])
      await tui.waitFor("This session", "ctrl+a did not return to the current-session view")
    } finally {
      tui.close()
    }
  } finally {
    await e2e.close()
  }
})

test.serial("manual interrupt pauses the panel and does not auto-recover", async () => {
  if (Bun.spawnSync(["tmux", "-V"]).exitCode !== 0) throw new Error("tmux is required for this E2E test")
  const e2e = await createOpenCodeE2E({
    plugin: "unicorn",
    pluginPackage: PACKAGE_ROOT,
    pluginOptions: {
      delayMs: 300,
      recheckMs: 500,
      cooldownMs: 0,
      minDurationMs: 1_000,
      maxDurationMs: 30 * 24 * 60 * 60_000,
    },
  })
  try {
    const toolID = `call_${crypto.randomUUID()}`
    e2e.proxy.mock.prependFixture({ match: { userMessage: DEFAULT_MESSAGE }, response: { content: "NUDGE_ACK" } })
    e2e.proxy.mock.prependFixture({ match: { toolCallId: toolID }, response: { content: "WAITED" } })
    e2e.proxy.mock.prependFixture({
      match: { userMessage: DEFAULT_MESSAGE, sequenceIndex: 0 },
      response: {
        toolCalls: [{ id: toolID, name: "shell", arguments: JSON.stringify({ command: "sleep 10" }) }],
      },
    })
    e2e.proxy.mock.prependFixture({
      match: { userMessage: "E2E_TUI_INTERRUPT", sequenceIndex: 0 },
      response: { content: "E2E_INTERRUPT_OK" },
    })

    const sessionID = await createSession(e2e, "Infinite-Loop-TUI-Interrupt")
    await prompt(e2e, sessionID, "E2E_TUI_INTERRUPT")
    const tui = createTui(e2e, sessionID, "infinite-loop-interrupt", { height: 52 })
    try {
      await tui.waitFor("Infinite-Loop-TUI-Interrupt", "the TUI did not start")
      await Bun.sleep(1_000)
      tui.type("/infinite-loop 5m cooldown=0")
      tui.send(["Enter"])
      await waitFor(async () => (await rpcStatus(e2e, sessionID)).active === true, "the loop did not start", 15_000)
      await waitFor(
        async () => ((await rpcStatus(e2e, sessionID)).sentCount ?? 0) >= 1,
        "the first nudge never arrived",
        20_000,
      )
      await tui.waitFor("esc interrupt", "the nudge turn did not start its shell", 20_000)

      // Interrupt the running turn from the TUI. One Escape is usually enough; a second
      // press covers the TUI's confirmation hint without touching the loop.
      for (let attempt = 0; attempt < 2; attempt++) {
        tui.send(["Escape"])
        await Bun.sleep(300)
        if ((await rpcStatus(e2e, sessionID)).phase === "paused") break
      }
      await waitFor(async () => (await rpcStatus(e2e, sessionID)).phase === "paused", "the loop did not pause", 10_000)

      // The panel must show the paused state and must not auto-recover.
      tui.type("/infinite-loop ")
      tui.send(["Enter"])
      await tui.waitFor("Paused after manual interrupt", "the panel did not show the paused state")
      const paused = await rpcStatus(e2e, sessionID)
      await Bun.sleep(1_500)
      expect((await rpcStatus(e2e, sessionID)).sentCount).toBe(paused.sentCount)

      // The paused panel can still stop the task explicitly.
      tui.send(["Tab"])
      tui.send(["Tab"])
      tui.send(["d"])
      await tui.waitFor("Infinite loop stopped", "the cleanup stop did not run")
      expect((await rpcStatus(e2e, sessionID)).active).toBe(false)
    } finally {
      tui.close()
    }
  } finally {
    await e2e.close()
  }
})
