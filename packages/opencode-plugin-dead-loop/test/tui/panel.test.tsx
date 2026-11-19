/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { InputRenderable, type Renderable } from "@opentui/core"
import { testRender } from "@opentui/solid"
import type { Context } from "@opencode/plugin/tui/context"
import { createSignal } from "solid-js"
import type { JSX } from "solid-js"
import { openDeadLoop, setupDeadLoopTui } from "../../src/tui.js"
import type { DeadLoopOptions } from "../../src/options.js"

type Harness = Awaited<ReturnType<typeof createHarness>>

const theme = {
  text: { base: "#ffffff", muted: "#aaaaaa", formfield: { base: "#ffffff" }, feedback: { error: { base: "#ff0000" } } },
  background: { raised: { high: "#333333" } },
  formfield: { base: "#ffffff" },
}

const options: DeadLoopOptions = {
  enabled: true,
  message: "Keep working without asking any questions.",
  delayMs: 3_000,
  recheckMs: 15_000,
  minDurationMs: 5 * 60_000,
  maxDurationMs: 7 * 24 * 60 * 60_000,
  defaultDurationMs: 60 * 60_000,
  presets: ["15m", "1h", "2h", "3h", "8h", "1d"],
  keybind: "ctrl+shift+l",
}

function createHarness(server: {
  status?: () => Record<string, unknown>
  start?: (input: { sessionID: string; durationMs: number }) => Record<string, unknown>
  stop?: (input: { sessionID: string }) => Record<string, unknown>
  fail?: string
} = {}) {
  const toasts: Array<{ message: string; variant?: string }> = []
  const layers: Array<{ commands: Array<{ title?: string; run: (input?: string) => void }> }> = []
  const [dialog, setDialog] = createSignal<{ render: () => JSX.Element } | undefined>()
  const calls: string[] = []

  const fail = () => {
    throw new Error(server.fail ?? "rpc unavailable")
  }
  const context = {
    options: {},
    location: { directory: "/workspace" },
    client: {
      rpc: () => ({
        status: async () => {
          calls.push("status")
          if (server.fail) fail()
          return server.status?.() ?? { active: false }
        },
        start: async (input: { sessionID: string; durationMs: number }) => {
          calls.push(`start:${input.durationMs}`)
          if (server.fail) fail()
          return server.start?.(input) ?? { active: true, sentCount: 0, deadline: Date.now() + input.durationMs }
        },
        stop: async (input: { sessionID: string }) => {
          calls.push("stop")
          if (server.fail) fail()
          return server.stop?.(input) ?? { active: false, outcome: { reason: "stopped", at: Date.now() } }
        },
      }),
    },
    data: { session: { get: () => ({ title: "Dead loop e2e session" }) } },
    theme,
    renderer: {},
    keymap: { layer: (factory: () => unknown) => { layers.push(factory() as never) } },
    ui: {
      router: { current: () => ({ type: "session" as const, sessionID: "session-1" }) },
      toast: { show: (input: { message: string; variant?: string }) => { toasts.push(input) } },
      dialog: {
        set() {},
        show(render: () => JSX.Element) { setDialog({ render }) },
        clear() { setDialog(undefined) },
      },
      format: { path: (value: string) => value },
    },
  } as unknown as Context

  setupDeadLoopTui(context)
  return { context, layers, toasts, dialog, calls }
}

async function render(harness: Harness) {
  return testRender(() => (
    <box width="100%" height="100%">
      {(() => { const entry = harness.dialog(); return entry ? entry.render() : null })()}
    </box>
  ), { width: 100, height: 40 })
}

function find<T extends Renderable>(root: Renderable, type: new (...args: any[]) => T): T | undefined {
  if (root instanceof type) return root
  for (const child of root.getChildren()) {
    const found = find(child, type)
    if (found) return found
  }
  return undefined
}

async function waitFor(app: Awaited<ReturnType<typeof render>>, check: () => boolean, message: string) {
  const deadline = Date.now() + 2_000
  while (Date.now() < deadline) {
    await app.flush()
    if (check()) return
    await Bun.sleep(5)
  }
  throw new Error(`${message}\n${app.captureCharFrame()}`)
}

function command(harness: Harness, title: string, input?: string) {
  for (const layer of [...harness.layers].reverse()) {
    const selected = layer.commands.find((entry) => entry.title === title)
    if (selected) {
      selected.run(input)
      return
    }
  }
  throw new Error(`Missing command: ${title}`)
}

test("registers the command with keybind and slash", () => {
  const harness = createHarness()
  const layer = harness.layers.at(-1)
  const command = layer?.commands.find((entry) => entry.title === "Open dead loop") as unknown as {
    id?: string
    bind?: string | false
    slash?: { name: string; arguments?: boolean }
    run?: (input?: string) => void
  }
  expect(command?.id).toBe("max10240.dead-loop.open")
  expect(command?.bind).toBe("ctrl+shift+l")
  expect(command?.slash).toMatchObject({ name: "deadloop", arguments: true })
})

test("slash with a duration starts directly without opening the panel", async () => {
  const harness = createHarness({ status: () => ({ active: true, sentCount: 1, deadline: Date.now() + 60_000 }) })
  await openDeadLoop(harness.context, options, "90m")
  expect(harness.calls).toEqual(["start:5400000"])
  expect(harness.toasts[0]?.message).toContain("Dead loop started")
  expect(harness.dialog()).toBeUndefined()
})

test("slash with an invalid duration opens the panel after a toast", async () => {
  const harness = createHarness()
  await openDeadLoop(harness.context, options, "2x")
  expect(harness.toasts[0]?.message).toContain("not a valid duration")
  expect(harness.dialog()).toBeDefined()
})

test("panel shows presets, status, and parses custom input live", async () => {
  const harness = createHarness({ status: () => ({ active: true, sentCount: 2, deadline: Date.now() + 45 * 60_000 }) })
  const app = await render(harness)
  try {
    command(harness, "Open dead loop")
    await waitFor(app, () => app.captureCharFrame().includes("Dead loop"), "panel did not open")
    await waitFor(app, () => app.captureCharFrame().includes("[1] 15m"), "presets missing")
    await waitFor(app, () => app.captureCharFrame().includes("sent 2 nudges"), "status missing")

    const input = find(app.renderer.root, InputRenderable)
    input!.value = "1h30m"
    await app.flush()
    await waitFor(app, () => app.captureCharFrame().includes("= 1h 30m"), "live preview missing")

    command(harness, "Start dead loop")
    await waitFor(app, () => harness.calls.includes("start:5400000"), "start was not called")
    expect(harness.toasts.some((toast) => toast.message.includes("Dead loop started · runs for 1h 30m"))).toBe(true)
  } finally {
    app.renderer.destroy()
  }
})

test("custom input shows the parse error and enter still guards", async () => {
  const harness = createHarness()
  const app = await render(harness)
  try {
    command(harness, "Open dead loop")
    await waitFor(app, () => app.captureCharFrame().includes("Not running"), "panel did not open")
    const input = find(app.renderer.root, InputRenderable)
    input!.value = "2x"
    await app.flush()
    await waitFor(app, () => app.captureCharFrame().includes("not a valid duration"), "parse error missing")
    command(harness, "Start dead loop")
    await Bun.sleep(50)
    await app.flush()
    expect(harness.calls).toEqual(["status"])
    expect(harness.toasts.some((toast) => toast.message.includes("not a valid duration"))).toBe(true)
  } finally {
    app.renderer.destroy()
  }
})

test("empty custom input starts the default duration", async () => {
  const harness = createHarness()
  const app = await render(harness)
  try {
    command(harness, "Open dead loop")
    await waitFor(app, () => app.captureCharFrame().includes("Not running"), "panel did not open")
    command(harness, "Start dead loop")
    await waitFor(app, () => harness.calls.includes("start:3600000"), "default start was not called")
  } finally {
    app.renderer.destroy()
  }
})

test("preset key starts immediately and d stops", async () => {
  const harness = createHarness({ status: () => ({ active: true, sentCount: 0, deadline: Date.now() + 60_000 }) })
  const app = await render(harness)
  try {
    command(harness, "Open dead loop")
    await waitFor(app, () => app.captureCharFrame().includes("[1] 15m"), "panel did not open")
    command(harness, "Start dead loop for 15m")
    await waitFor(app, () => harness.calls.includes("start:900000"), "preset start was not called")

    command(harness, "Stop dead loop")
    await waitFor(app, () => harness.calls.includes("stop"), "stop was not called")
    await waitFor(app, () => app.captureCharFrame().includes("Stopped at"), "stopped state missing")
  } finally {
    app.renderer.destroy()
  }
})

test("rpc failures surface in the panel", async () => {
  const harness = createHarness({ fail: "not registered" })
  const app = await render(harness)
  try {
    command(harness, "Open dead loop")
    await waitFor(app, () => app.captureCharFrame().includes("Dead loop server is unavailable"), "unavailable message missing")
  } finally {
    app.renderer.destroy()
  }
})

test("expired outcome is displayed", async () => {
  const harness = createHarness({ status: () => ({ active: false, outcome: { reason: "expired", at: Date.now() } }) })
  const app = await render(harness)
  try {
    command(harness, "Open dead loop")
    await waitFor(app, () => app.captureCharFrame().includes("Expired at"), "expired state missing")
  } finally {
    app.renderer.destroy()
  }
})
