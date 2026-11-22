/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { RGBA } from "@opentui/core"
import { testRender } from "@opentui/solid"
import type { Context } from "@opencode/plugin/tui/context"
import type { JSX } from "solid-js"
import type { DelayedQueueOptions } from "../../src/options.js"
import { DelayedQueueDock, setupDelayedQueueTui } from "../../src/tui.js"

const options: DelayedQueueOptions = {
  enabled: true,
  keybind: "<leader>d",
  queueKeybind: "f9",
  recheckMs: 5_000,
  waitKinds: ["shell", "subagent", "image", "video", "codemode"],
  waitDescendants: true,
  pauseOnInterrupt: true,
  pauseOnFailure: true,
}

const theme = {
  text: {
    base: "#ffffff",
    muted: "#aaaaaa",
    formfield: { base: "#ffffff" },
    feedback: { warning: { base: "#ffaa00" } },
  },
  background: {
    base: "#111111",
    raised: { base: "#222222", high: "#333333" },
    formfield: { base: "#222222", focused: "#333333" },
  },
  border: { base: "#444444" },
  decrease: (value: string) => value,
  surface: () => theme,
}

const state = {
  sessionID: "s1",
  paused: false,
  items: [
    { id: "msg_1", text: "first delayed", createdAt: 1 },
    { id: "msg_2", text: "second delayed", createdAt: 2 },
  ],
  waitingFor: [],
  observed: true,
  delivering: false,
  updatedAt: 2,
}

function harness(overrides: Partial<Record<string, unknown>> = {}, behavior: { removeError?: boolean } = {}) {
  const layers: any[] = []
  const slots: any[] = []
  const toasts: Array<{ message: string; variant?: string }> = []
  const calls: string[] = []
  const shows: Array<{ render: () => JSX.Element; close?: () => void }> = []
  let clears = 0
  const current = { ...state, ...overrides }
  const context = {
    options: {},
    location: { directory: "/workspace" },
    data: { job: { list: () => [] }, session: { get: () => undefined }, location: { default: () => ({ directory: "/workspace" }) } },
    experimental: undefined,
    theme,
    renderer: { currentFocusedEditor: null },
    keymap: { layer: (factory: () => unknown) => { layers.push(factory()) } },
    ui: {
      router: { current: () => ({ type: "session" as const, sessionID: "s1" }) },
      toast: { show: (value: { message: string; variant?: string }) => { toasts.push(value) } },
      slot: (claim: any) => {
        slots.push(claim)
        return () => {}
      },
      dialog: {
        show: (render: () => JSX.Element, close?: () => void) => { shows.push({ render, close }) },
        set() {},
        clear() { clears++ },
        prompt: async () => undefined,
        select: async () => undefined,
      },
    },
    client: {
      experimental: { job: { list: async () => [] } },
      rpc: () => ({
        status: async () => current,
        syncJobs: async () => current,
        enqueue: async (input: unknown) => {
          calls.push(`enqueue:${JSON.stringify(input)}`)
          return current
        },
        remove: async (input: { ids: string[] }) => {
          calls.push(`remove:${input.ids.join(",")}`)
          if (behavior.removeError) throw new Error("remove failed")
          return { ...current, items: current.items.filter((item) => !input.ids.includes(item.id)) }
        },
        pause: async () => {
          calls.push("pause")
          return { ...current, paused: true, pauseReason: "manual" }
        },
        resume: async () => {
          calls.push("resume")
          return { ...current, paused: false, pauseReason: undefined }
        },
        deliver: async (input: { id: string }) => {
          calls.push(`deliver:${input.id}`)
          return { ...current, items: current.items.filter((item) => item.id !== input.id) }
        },
        events: { on: () => () => {} },
      }),
    },
  } as unknown as Context
  setupDelayedQueueTui(context)
  return { context, layers, slots, toasts, calls, shows, current, clears: () => clears }
}

function panelCommand(fx: ReturnType<typeof harness>, title: string) {
  return fx.layers.flatMap((layer) => layer.commands ?? []).find((command) => command.title === title)
}

async function openPanel(fx: ReturnType<typeof harness>) {
  await fx.layers[0].commands[0].run("")
  await Bun.sleep(0)
  expect(fx.shows).toHaveLength(1)
}

async function renderPanel(fx: ReturnType<typeof harness>) {
  const app = await testRender(() => <box width="100%" height="100%">{fx.shows[0]!.render()}</box>, { width: 120, height: 30 })
  await Bun.sleep(10)
  await app.flush()
  return app
}

test("registers the standard command and slash aliases", () => {
  const fx = harness()
  const commands = fx.layers[0].commands
  expect(commands).toHaveLength(2)
  expect(commands[0]).toMatchObject({
    id: "max10240.delayed-queue.open",
    bind: "<leader>d",
    palette: true,
    slash: { name: "delayed-queue", arguments: true },
  })
  expect(commands[1]).toMatchObject({ id: "max10240.delayed-queue.enqueue", bind: "f9", palette: true })
  expect(fx.slots).toHaveLength(1)
  expect(fx.slots[0].append).toBe("session.composer.top")
})

test("slash with text enqueues through RPC without a success toast", async () => {
  const fx = harness()
  await fx.layers[0].commands[0].run("delayed text")
  await Bun.sleep(0)
  expect(fx.calls[0]).toContain('"text":"delayed text"')
  expect(fx.calls[0]).toContain('"jobs":[]')
  expect(fx.toasts).toEqual([])
  expect(fx.shows).toHaveLength(0)
})

test("enqueue warns when the queue is paused", async () => {
  const fx = harness({ paused: true })
  await fx.layers[0].commands[0].run("delayed text")
  await Bun.sleep(0)
  expect(fx.toasts).toEqual([{ message: "Delayed message queued · resume the queue to run it", variant: "warning" }])
})

test("slash without text opens the delayed prompt panel", async () => {
  const fx = harness()
  await openPanel(fx)
  expect(fx.clears()).toBe(0)
  const app = await renderPanel(fx)
  try {
    expect(app.captureCharFrame()).toContain("Delayed prompts")
  } finally {
    app.renderer.destroy()
  }
})

test("Ctrl+D deletes the selected prompt once and keeps the panel open", async () => {
  const fx = harness()
  await openPanel(fx)
  const app = await renderPanel(fx)
  try {
    expect(app.captureCharFrame()).toContain("▶ first delayed")
    const remove = panelCommand(fx, "Delete selected delayed prompt")!
    remove.run()
    panelCommand(fx, "Pause delayed queue")!.run()
    remove.run()
    await Bun.sleep(10)
    await app.flush()
    const frame = app.captureCharFrame()
    expect(fx.calls.filter((call) => call.startsWith("remove:"))).toEqual(["remove:msg_1"])
    expect(fx.calls).not.toContain("pause")
    expect(fx.toasts).toEqual([])
    expect(frame).not.toContain("first delayed")
    expect(frame).toContain("▶ second delayed")
    expect(frame).toContain("1 of 1")
    expect(fx.clears()).toBe(0)
  } finally {
    app.renderer.destroy()
  }
})

test("deleting the last prompt closes the panel", async () => {
  const fx = harness({ items: [state.items[0]] })
  await openPanel(fx)
  const app = await renderPanel(fx)
  try {
    panelCommand(fx, "Delete selected delayed prompt")!.run()
    await Bun.sleep(10)
    expect(fx.calls.filter((call) => call.startsWith("remove:"))).toEqual(["remove:msg_1"])
    expect(fx.clears()).toBe(1)
  } finally {
    app.renderer.destroy()
  }
})

test("panel pause updates the whole queue and explains why it is paused", async () => {
  const fx = harness()
  await openPanel(fx)
  const app = await renderPanel(fx)
  try {
    panelCommand(fx, "Pause delayed queue")!.run()
    await Bun.sleep(10)
    await app.flush()
    expect(fx.calls).toEqual(["pause"])
    expect(fx.shows).toHaveLength(1)
    expect(fx.clears()).toBe(0)
    expect(fx.toasts).toEqual([{ message: "Paused the whole delayed queue · messages stay queued", variant: "info" }])
    const frame = app.captureCharFrame()
    expect(frame).toContain("Whole queue paused")
    expect(frame).toContain("manually")
    expect(frame).toContain("2 messages stay queued · automatic delivery is off · ctrl+s still sends one now")
    expect(frame).toContain("ctrl+p resume queue")
    expect(frame).toContain("2 queued · paused")
    expect(frame).toContain("▶ first delayed")
  } finally {
    app.renderer.destroy()
  }
})

test("clicking the pause footer pauses the whole queue", async () => {
  const fx = harness()
  await openPanel(fx)
  const app = await renderPanel(fx)
  try {
    const lines = app.captureCharFrame().split("\n")
    const row = lines.findIndex((line) => line.includes("ctrl+p pause queue"))
    expect(row).toBeGreaterThanOrEqual(0)
    await app.mockMouse.click(lines[row]!.indexOf("ctrl+p pause queue") + 2, row)
    await Bun.sleep(20)
    await app.flush()
    expect(fx.calls).toEqual(["pause"])
    expect(app.captureCharFrame()).toContain("Whole queue paused")
  } finally {
    app.renderer.destroy()
  }
})

test("an automatic pause shows its reason", async () => {
  const fx = harness({ paused: true, pauseReason: "interrupted" })
  await openPanel(fx)
  const app = await renderPanel(fx)
  try {
    const frame = app.captureCharFrame()
    expect(frame).toContain("Whole queue paused")
    expect(frame).toContain("after an interrupt")
    expect(frame).toContain("2 messages stay queued · automatic delivery is off · ctrl+s still sends one now")
    expect(frame).toContain("ctrl+p resume queue")
  } finally {
    app.renderer.destroy()
  }
})

test("a paused queue without a recorded reason says so", async () => {
  const fx = harness({ paused: true })
  await openPanel(fx)
  const app = await renderPanel(fx)
  try {
    const frame = app.captureCharFrame()
    expect(frame).toContain("Whole queue paused")
    expect(frame).toContain("no reason recorded")
    expect(frame).not.toContain("manually")
  } finally {
    app.renderer.destroy()
  }
})

test("a failed delete keeps the panel and selection", async () => {
  const fx = harness({}, { removeError: true })
  await openPanel(fx)
  const app = await renderPanel(fx)
  try {
    panelCommand(fx, "Delete selected delayed prompt")!.run()
    await Bun.sleep(10)
    await app.flush()
    expect(fx.toasts.at(-1)?.message).toBe("remove failed")
    expect(fx.toasts.at(-1)?.variant).toBe("error")
    expect(app.captureCharFrame()).toContain("▶ first delayed")
    expect(fx.clears()).toBe(0)
  } finally {
    app.renderer.destroy()
  }
})

test("the dock renders the official queue-style pending bar", async () => {
  const fx = harness()
  const app = await testRender(() => (
    <box width="100%" height="100%">
      <DelayedQueueDock context={fx.context} sessionID="s1" options={options} />
    </box>
  ), { width: 100, height: 20 })
  try {
    await Bun.sleep(10)
    await app.flush()
    const frame = app.captureCharFrame()
    expect(frame).toContain("2 delayed")
    expect(frame).toContain("first delayed")
  } finally {
    app.renderer.destroy()
  }
})

test("the dock keeps the paused indicator visible before a long message", async () => {
  const fx = harness({ paused: true, items: [{ id: "msg_1", text: "x".repeat(300), createdAt: 1 }] })
  const app = await testRender(() => (
    <box width="100%" height="100%">
      <DelayedQueueDock context={fx.context} sessionID="s1" options={options} />
    </box>
  ), { width: 60, height: 20 })
  try {
    await Bun.sleep(10)
    await app.flush()
    const frame = app.captureCharFrame()
    expect(frame).toContain("⏸ 1 delayed · paused")
    expect(frame).not.toContain("paused after")
  } finally {
    app.renderer.destroy()
  }
})

test("the dock shows why the queue paused", async () => {
  const fx = harness({ paused: true, pauseReason: "interrupted" })
  const app = await testRender(() => (
    <box width="100%" height="100%">
      <DelayedQueueDock context={fx.context} sessionID="s1" options={options} />
    </box>
  ), { width: 80, height: 20 })
  try {
    await Bun.sleep(10)
    await app.flush()
    const frame = app.captureCharFrame()
    expect(frame).toContain("⏸ 2 delayed · paused after interrupt")
    expect(frame).toContain("first delayed")
    const border = app.captureSpans().lines.flatMap((line) => line.spans).find((span) => span.text.includes("┃"))
    expect(border?.fg.toInts()).toEqual(RGBA.fromHex("#ffaa00").toInts())
  } finally {
    app.renderer.destroy()
  }
})
