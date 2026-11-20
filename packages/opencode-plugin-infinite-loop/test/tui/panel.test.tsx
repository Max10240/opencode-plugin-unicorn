/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { InputRenderable, type Renderable } from "@opentui/core"
import { testRender } from "@opentui/solid"
import type { Context } from "@opencode/plugin/tui/context"
import { createSignal } from "solid-js"
import type { JSX } from "solid-js"
import { openInfiniteLoop, openInfiniteLoopOverview, setupInfiniteLoopTui } from "../../src/tui.js"
import type { InfiniteLoopOptions } from "../../src/options.js"

type Harness = Awaited<ReturnType<typeof createHarness>>
type Loop = Record<string, unknown>

const theme = {
  text: {
    base: "#ffffff",
    muted: "#aaaaaa",
    formfield: { base: "#ffffff" },
    action: { primary: { base: "#00ffff" } },
    feedback: { error: { base: "#ff0000" }, warning: { base: "#ffaa00" }, info: { base: "#00aaff" } },
  },
  background: { raised: { high: "#333333" } },
  formfield: { base: "#ffffff" },
  surface: () => theme,
}

const options: InfiniteLoopOptions = {
  enabled: true,
  message: "Keep working without asking any questions.",
  delayMs: 3_000,
  recheckMs: 2_000,
  cooldownMs: 5 * 60_000,
  minDurationMs: 5 * 60_000,
  maxDurationMs: 7 * 24 * 60 * 60_000,
  defaultDurationMs: 60 * 60_000,
  presets: ["15m", "1h", "2h", "3h", "8h", "1d"],
  keybind: "ctrl+shift+i",
  overviewKeybind: "ctrl+shift+o",
}

function loop(overrides: Loop = {}): Loop {
  const now = Date.now()
  return {
    sessionID: "session-1",
    title: "Main",
    directory: "/workspace",
    active: true,
    startedAt: now - 60_000,
    deadline: now + 60 * 60_000,
    sentCount: 2,
    lastSentAt: now - 120_000,
    cooldownMs: 5 * 60_000,
    cooldownUntil: now + 2 * 60_000,
    phase: "waiting",
    nudging: false,
    ...overrides,
  }
}

function createHarness(server: {
  status?: () => Record<string, unknown>
  start?: (input: { sessionID: string; durationMs: number; cooldownMs?: number }) => Record<string, unknown>
  stop?: (input: { sessionID: string }) => Record<string, unknown>
  list?: () => Loop[]
  fail?: string
  confirm?: boolean
  sessionID?: string
} = {}) {
  const toasts: Array<{ message: string; variant?: string }> = []
  const layers: Array<{ target?: unknown; enabled?: () => boolean; commands: Array<{ id?: string; bind?: string; title?: string; slash?: unknown; run: (input?: string) => unknown }> }> = []
  const slots: Array<{ append?: string; render: (input: any) => JSX.Element }> = []
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
        status: async (input: { sessionID: string }) => {
          calls.push(`status:${input.sessionID}`)
          if (server.fail) fail()
          return server.status?.() ?? { active: false }
        },
        start: async (input: { sessionID: string; durationMs: number; cooldownMs?: number }) => {
          calls.push(`start:${input.durationMs}:${input.cooldownMs ?? "default"}`)
          if (server.fail) fail()
          return server.start?.(input) ?? { active: true, sentCount: 0, deadline: Date.now() + input.durationMs, cooldownMs: input.cooldownMs }
        },
        stop: async (input: { sessionID: string }) => {
          calls.push(`stop:${input.sessionID}`)
          if (server.fail) fail()
          return server.stop?.(input) ?? { active: false, outcome: { reason: "stopped", at: Date.now() } }
        },
        list: async () => {
          calls.push("list")
          if (server.fail) fail()
          return server.list?.() ?? []
        },
      }),
    },
    data: { session: { get: () => ({ title: "Loop session" }) } },
    theme,
    renderer: {},
    keymap: { layer: (factory: () => unknown) => { layers.push(factory() as never) } },
    ui: {
      router: { current: () => ({ type: "session" as const, sessionID: server.sessionID ?? "session-1" }) },
      toast: { show: (input: { message: string; variant?: string }) => { toasts.push(input) } },
      dialog: {
        set() {},
        show(render: () => JSX.Element) { setDialog({ render }) },
        clear() { setDialog(undefined) },
        confirm: async () => server.confirm ?? true,
      },
      format: { path: (value: string) => value },
      slot: (claim: { append?: string; render: (input: any) => JSX.Element }) => {
        slots.push(claim)
        return () => {}
      },
    },
  } as unknown as Context

  setupInfiniteLoopTui(context)
  return { context, layers, toasts, dialog, calls, slots }
}

async function render(harness: Harness) {
  return testRender(() => (
    <box width="100%" height="100%">
      {(() => { const entry = harness.dialog(); return entry ? entry.render() : null })()}
    </box>
  ), { width: 110, height: 42 })
}

function find<T extends Renderable>(root: Renderable, type: new (...args: any[]) => T): T | undefined {
  if (root instanceof type) return root
  for (const child of root.getChildren()) {
    const found = find(child, type)
    if (found) return found
  }
  return undefined
}

function findAll<T extends Renderable>(root: Renderable, type: new (...args: any[]) => T): T[] {
  const result: T[] = []
  if (root instanceof type) result.push(root)
  for (const child of root.getChildren()) result.push(...findAll(child, type))
  return result
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

test("registers current-session and overview commands with keybinds and slashes", () => {
  const harness = createHarness()
  const layer = harness.layers[0]
  const open = layer?.commands.find((entry) => entry.title === "Open infinite loop") as unknown as {
    id?: string
    bind?: string | false
    slash?: { name: string; arguments?: boolean }
  }
  const overview = layer?.commands.find((entry) => entry.title === "Open infinite loops") as unknown as {
    id?: string
    bind?: string | false
    slash?: { name: string }
  }
  expect(open?.id).toBe("max10240.infinite-loop.open")
  expect(open?.bind).toBe("ctrl+shift+i")
  expect(open?.slash).toMatchObject({ name: "infinite-loop", arguments: true })
  expect(overview?.id).toBe("max10240.infinite-loop.overview")
  expect(overview?.bind).toBe("ctrl+shift+o")
  expect(overview?.slash).toMatchObject({ name: "infinite-loops", arguments: true })
})

test("typing-relevant keys only live in focus-scoped layers", async () => {
  const harness = createHarness()
  const app = await render(harness)
  try {
    command(harness, "Open infinite loop")
    await waitFor(app, () => app.captureCharFrame().includes("Not running"), "panel did not open")
    const base = harness.layers.find((layer) => layer.commands.some((entry) => entry.bind === "escape"))
    expect(base).toBeDefined()
    expect(base?.commands.every((entry) => entry.bind !== "d" && entry.bind !== "return" && !/^\d$/.test(entry.bind ?? ""))).toBe(true)
    const duration = harness.layers.find((layer) => layer.commands.some((entry) => entry.bind === "return" && entry.title === "Start infinite loop"))
    expect(typeof duration?.target).toBe("function")
    const cooldown = harness.layers.find((layer) => layer.commands.some((entry) => entry.bind === "tab" && entry.title === "Focus presets"))
    expect(typeof cooldown?.target).toBe("function")
    const presets = harness.layers.find((layer) => layer.commands.some((entry) => entry.bind === "2"))
    expect(typeof presets?.target).toBe("function")
    expect(presets?.commands.some((entry) => entry.bind === "d")).toBe(true)
  } finally {
    app.renderer.destroy()
  }
})

test("slash with a duration and cooldown starts directly", async () => {
  const harness = createHarness()
  await openInfiniteLoop(harness.context, options, "90m cooldown=10m")
  expect(harness.calls).toEqual(["start:5400000:600000"])
  expect(harness.toasts[0]?.message).toContain("Infinite loop started")
  expect(harness.toasts[0]?.message).toContain("1h 30m")
  expect(harness.toasts[0]?.message).toContain("cooldown 10m")
  expect(harness.dialog()).toBeUndefined()
})

test("slash with an invalid duration opens the panel after a toast", async () => {
  const harness = createHarness()
  await openInfiniteLoop(harness.context, options, "2x")
  expect(harness.toasts[0]?.message).toContain("not a valid duration")
  expect(harness.dialog()).toBeDefined()
})

test("panel shows presets, active status, and parses duration and cooldown live", async () => {
  const harness = createHarness({
    status: () => loop(),
    list: () => [loop()],
  })
  const app = await render(harness)
  try {
    command(harness, "Open infinite loop")
    await waitFor(app, () => app.captureCharFrame().includes("Infinite loop"), "panel did not open")
    await waitFor(app, () => app.captureCharFrame().includes("[1] 15m"), "presets missing")
    await waitFor(app, () => app.captureCharFrame().includes("Running · sent 2 nudges"), "status missing")
    await waitFor(app, () => app.captureCharFrame().includes("Cooling down"), "cooldown status missing")

    const inputs = findAll(app.renderer.root, InputRenderable)
    expect(inputs).toHaveLength(2)
    inputs[0]!.value = "1h30m"
    inputs[1]!.value = "5"
    await app.flush()
    await waitFor(app, () => app.captureCharFrame().includes("= 1h 30m"), "duration preview missing")
    await waitFor(app, () => app.captureCharFrame().includes("= 5m"), "cooldown preview missing")

    command(harness, "Start infinite loop")
    await waitFor(app, () => harness.calls.includes("start:5400000:300000"), "start was not called")
    expect(harness.toasts.some((toast) => toast.message.includes("Infinite loop started · runs for 1h 30m · cooldown 5m"))).toBe(true)
  } finally {
    app.renderer.destroy()
  }
})

test("invalid duration and cooldown inputs show errors and enter is guarded", async () => {
  const harness = createHarness()
  const app = await render(harness)
  try {
    command(harness, "Open infinite loop")
    await waitFor(app, () => app.captureCharFrame().includes("Not running"), "panel did not open")
    const inputs = findAll(app.renderer.root, InputRenderable)
    inputs[0]!.value = "2x"
    inputs[1]!.value = "abc"
    await app.flush()
    await waitFor(app, () => app.captureCharFrame().includes("not a valid duration"), "duration error missing")
    await waitFor(app, () => app.captureCharFrame().includes("not a valid duration"), "cooldown error missing")
    command(harness, "Start infinite loop")
    await Bun.sleep(50)
    await app.flush()
    expect(harness.calls).toEqual(["status:session-1", "list"])
  } finally {
    app.renderer.destroy()
  }
})

test("empty inputs start the default duration and default cooldown", async () => {
  const harness = createHarness()
  const app = await render(harness)
  try {
    command(harness, "Open infinite loop")
    await waitFor(app, () => app.captureCharFrame().includes("Not running"), "panel did not open")
    command(harness, "Start infinite loop")
    await waitFor(app, () => harness.calls.includes("start:3600000:default"), "default start was not called")
  } finally {
    app.renderer.destroy()
  }
})

test("preset key starts with the cooldown input value", async () => {
  const harness = createHarness()
  const app = await render(harness)
  try {
    command(harness, "Open infinite loop")
    await waitFor(app, () => app.captureCharFrame().includes("[1] 15m"), "panel did not open")
    const inputs = findAll(app.renderer.root, InputRenderable)
    inputs[1]!.value = "0"
    await app.flush()
    command(harness, "Start infinite loop for 15m")
    await waitFor(app, () => harness.calls.includes("start:900000:0"), "preset start was not called")
  } finally {
    app.renderer.destroy()
  }
})

test("expired outcome is displayed", async () => {
  const harness = createHarness({
    status: () => ({ active: false, outcome: { reason: "expired", at: Date.now(), sentCount: 3 } }),
  })
  const app = await render(harness)
  try {
    command(harness, "Open infinite loop")
    await waitFor(app, () => app.captureCharFrame().includes("Expired at"), "expired state missing")
  } finally {
    app.renderer.destroy()
  }
})

test("rpc failures surface in the panel", async () => {
  const harness = createHarness({ fail: "not registered" })
  const app = await render(harness)
  try {
    command(harness, "Open infinite loop")
    await waitFor(app, () => app.captureCharFrame().includes("Infinite loop server is unavailable"), "unavailable message missing")
  } finally {
    app.renderer.destroy()
  }
})

test("all-projects view groups loops and stops the selected one", async () => {
  const second = loop({ sessionID: "session-2", title: "Other", directory: "/other", phase: "paused", cooldownUntil: undefined })
  const harness = createHarness({ list: () => [loop(), second], status: () => loop() })
  const app = await render(harness)
  try {
    openInfiniteLoopOverview(harness.context, options)
    await waitFor(app, () => app.captureCharFrame().includes("Infinite loops"), "overview did not open")
    await waitFor(app, () => app.captureCharFrame().includes("/workspace"), "workspace group missing")
    await waitFor(app, () => app.captureCharFrame().includes("/other"), "other group missing")
    await waitFor(app, () => app.captureCharFrame().includes("(current)"), "current marker missing")
    command(harness, "Stop selected infinite loop")
    await waitFor(app, () => harness.calls.includes("stop:session-1"), "stop selected was not called")
  } finally {
    app.renderer.destroy()
  }
})

test("stop all confirms and stops every listed loop", async () => {
  const second = loop({ sessionID: "session-2", title: "Other", directory: "/other" })
  const harness = createHarness({ list: () => [loop(), second], confirm: true })
  const app = await render(harness)
  try {
    openInfiniteLoopOverview(harness.context, options)
    await waitFor(app, () => app.captureCharFrame().includes("Infinite loops"), "overview did not open")
    command(harness, "Stop all infinite loops")
    await waitFor(app, () => harness.calls.includes("stop:session-1") && harness.calls.includes("stop:session-2"), "stop all was not called")
    expect(harness.toasts.some((toast) => toast.message.includes("Stopped 2 infinite loops"))).toBe(true)
  } finally {
    app.renderer.destroy()
  }
})

test("ctrl+a toggles between the current session and all projects", async () => {
  const harness = createHarness({ list: () => [loop()], status: () => loop() })
  const app = await render(harness)
  try {
    command(harness, "Open infinite loop")
    await waitFor(app, () => app.captureCharFrame().includes("Not running") || app.captureCharFrame().includes("Running · sent"), "panel did not open")
    command(harness, "Toggle all infinite loops")
    await waitFor(app, () => app.captureCharFrame().includes("All projects"), "all view did not open")
    command(harness, "Toggle all infinite loops")
    await waitFor(app, () => app.captureCharFrame().includes("This session") || app.captureCharFrame().includes("Not running") || app.captureCharFrame().includes("Running · sent"), "current view did not return")
  } finally {
    app.renderer.destroy()
  }
})

test("help opens with f1 and escape closes help before the panel", async () => {
  const harness = createHarness()
  const app = await render(harness)
  try {
    command(harness, "Open infinite loop")
    await waitFor(app, () => app.captureCharFrame().includes("Not running"), "panel did not open")
    command(harness, "Toggle infinite loop help")
    await waitFor(app, () => app.captureCharFrame().includes("Keyboard help"), "help did not open")
    command(harness, "Close infinite loop")
    await waitFor(app, () => !app.captureCharFrame().includes("Keyboard help"), "help did not close")
    expect(harness.dialog()).toBeDefined()
  } finally {
    app.renderer.destroy()
  }
})

test("footer status chip shows the active loop and remaining time", async () => {
  const harness = createHarness({ status: () => loop({ deadline: Date.now() + 90 * 60_000 }) })
  expect(harness.slots).toHaveLength(1)
  expect(harness.slots[0]?.append).toBe("prompt.footer.status")
  const app = await testRender(() => harness.slots[0]!.render({ sessionID: "session-1", mode: "normal", showDetails: false }), { width: 80, height: 6 })
  try {
    await waitFor(app, () => app.captureCharFrame().includes("∞ LOOP"), "status chip missing")
    await waitFor(app, () => app.captureCharFrame().includes("1h 30m"), "remaining time missing")
  } finally {
    app.renderer.destroy()
  }
})

test("empty all-projects view shows the empty state", async () => {
  const harness = createHarness({ list: () => [] })
  const app = await render(harness)
  try {
    openInfiniteLoopOverview(harness.context, options)
    await waitFor(app, () => app.captureCharFrame().includes("No running loops"), "empty state missing")
  } finally {
    app.renderer.destroy()
  }
})
