/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
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
  text: { base: "#ffffff", muted: "#aaaaaa" },
  background: { raised: { base: "#222222" } },
  border: { base: "#444444" },
  decrease: (value: string) => value,
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

type SelectOptions = {
  title: string
  options: Array<{ title: string; value: string; footer?: string }>
  actions: Array<{ title: string; selection: string; onTrigger: (value: string) => void }>
  search: (query: string, options: Array<{ title: string; value: string }>) => Array<{ title: string; value: string }>
  onSelect?: (value: string) => void
}

function harness(overrides: Partial<Record<string, unknown>> = {}) {
  let layer: any
  const slots: any[] = []
  const toasts: Array<{ message: string; variant?: string }> = []
  const calls: string[] = []
  const dialogs: SelectOptions[] = []
  const current = { ...state, ...overrides }
  const context = {
    options: {},
    location: { directory: "/workspace" },
    data: { job: { list: () => [] }, session: { get: () => undefined }, location: { default: () => ({ directory: "/workspace" }) } },
    experimental: undefined,
    theme,
    renderer: { currentFocusedEditor: null },
    keymap: { layer: (factory: () => unknown) => { layer = factory() } },
    ui: {
      router: { current: () => ({ type: "session" as const, sessionID: "s1" }) },
      toast: { show: (value: { message: string; variant?: string }) => { toasts.push(value) } },
      slot: (claim: any) => {
        slots.push(claim)
        return () => {}
      },
      dialog: {
        show: (_render: () => JSX.Element) => {},
        set() {},
        clear() {},
        prompt: async () => undefined,
        select: async (value: SelectOptions) => {
          dialogs.push(value)
          return undefined
        },
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
          return { ...current, items: current.items.filter((item) => !input.ids.includes(item.id)) }
        },
        pause: async () => {
          calls.push("pause")
          return { ...current, paused: true }
        },
        resume: async () => {
          calls.push("resume")
          return { ...current, paused: false }
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
  return { context, layer, slots, toasts, calls, dialogs, current }
}

test("registers the standard command and slash aliases", () => {
  const fx = harness()
  const commands = fx.layer.commands
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

test("slash with text enqueues through RPC and reports success", async () => {
  const fx = harness()
  await fx.layer.commands[0].run("delayed text")
  await Bun.sleep(0)
  expect(fx.calls[0]).toContain('"text":"delayed text"')
  expect(fx.calls[0]).toContain('"jobs":[]')
  expect(fx.toasts.at(-1)?.variant).toBe("success")
  expect(fx.dialogs).toHaveLength(0)
})

test("slash without text opens the delayed prompt panel", async () => {
  const fx = harness()
  await fx.layer.commands[0].run("")
  await Bun.sleep(0)
  expect(fx.dialogs).toHaveLength(1)
  const panel = fx.dialogs[0]!
  expect(panel.title).toBe("Delayed prompts")
  expect(panel.options.map((item) => item.title)).toEqual(["first delayed", "second delayed"])
  expect(panel.search("second", panel.options).map((item) => item.value)).toEqual(["msg_2"])
})

test("panel delete action removes the selected prompt", async () => {
  const fx = harness()
  await fx.layer.commands[0].run("")
  await Bun.sleep(0)
  const action = fx.dialogs[0]!.actions.find((entry) => entry.title === "delete")!
  action.onTrigger("msg_1")
  await Bun.sleep(0)
  expect(fx.calls).toContain("remove:msg_1")
  expect(fx.toasts.at(-1)?.message).toBe("Delayed prompt deleted")
})

test("panel pause action changes the session state", async () => {
  const fx = harness()
  await fx.layer.commands[0].run("")
  await Bun.sleep(0)
  const action = fx.dialogs[0]!.actions.find((entry) => entry.title === "pause")!
  action.onTrigger("")
  await Bun.sleep(0)
  expect(fx.calls).toContain("pause")
  expect(fx.toasts.at(-1)?.message).toBe("Delayed queue paused")
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
