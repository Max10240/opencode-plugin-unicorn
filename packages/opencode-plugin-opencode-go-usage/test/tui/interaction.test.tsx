/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import type { Context } from "@opencode/plugin/tui/context"
import { testRender } from "@opentui/solid"
import { createSignal, type JSX } from "solid-js"
import { setupOpencodeGoUsageTui } from "../../src/tui.js"
import type { AccountUsage } from "../../src/usage.js"

const theme = {
  text: {
    base: "#ffffff",
    muted: "#aaaaaa",
    formfield: { base: "#ffffff" },
    feedback: { error: { base: "#ff0000" }, warning: { base: "#ffff00" }, success: { base: "#00ff00" } },
  },
  background: { raised: { high: "#333333" } },
  formfield: { base: "#ffffff" },
  surface: () => theme,
}

const account: AccountUsage = {
  id: "cred_work",
  label: "Work",
  active: true,
  state: "ok",
  workspace: { id: "org_work", name: "Acme" },
  usage: {
    rolling: { percent: 42, limited: false, resetsAt: Date.now() + 60_000 },
    weekly: { percent: 18, limited: false, resetsAt: Date.now() + 120_000 },
    monthly: { percent: 7, limited: false, resetsAt: Date.now() + 180_000 },
  },
}

function createHarness(input: { accounts?: AccountUsage[]; reject?: boolean } = {}) {
  const accounts = input.accounts ?? [account]
  const layers: any[] = []
  const [dialogEntry, setDialogEntry] = createSignal<{ render: () => JSX.Element }>()
  let listCalls = 0
  const context = {
    options: { enabled: true },
    keymap: {
      layer: (factory: () => any) => {
        layers.push(factory())
      },
    },
    client: {
      rpc: () => ({
        accounts: async () => ({ accounts: accounts.map(({ id, label, active }) => ({ id, label, active })) }),
        list: async () => {
          listCalls++
          if (input.reject) throw new Error("usage unavailable")
          return { accounts }
        },
      }),
    },
    data: { on: () => () => {} },
    theme,
    ui: {
      dialog: {
        set() {},
        show(render: () => JSX.Element) {
          setDialogEntry({ render })
        },
        clear() {
          setDialogEntry(undefined)
        },
      },
    },
  } as unknown as Context

  setupOpencodeGoUsageTui(context)
  return {
    context,
    layers,
    dialogEntry,
    listCalls: () => listCalls,
    open: () => {
      const command = layers.find((layer) => layer.mode === "global")?.commands[0]
      command.run()
    },
  }
}

type Harness = ReturnType<typeof createHarness>

async function render(harness: Harness) {
  return testRender(
    () => (
      <box width="100%" height="100%">
        {(() => {
          const entry = harness.dialogEntry()
          return entry ? entry.render() : null
        })()}
      </box>
    ),
    { width: 100, height: 50 },
  )
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

function command(harness: Harness, title: string) {
  const layer = [...harness.layers].reverse().find((entry) => entry.commands.some((item: any) => item.title === title))
  const selected = layer?.commands.find((item: any) => item.title === title)
  if (!selected) throw new Error(`Missing command: ${title}`)
  selected.run()
}

test("renders every Go window and refreshes with r", async () => {
  const harness = createHarness()
  const app = await render(harness)
  try {
    harness.open()
    await waitFor(app, () => app.captureCharFrame().includes("Work (active)"), "usage dialog did not open")
    const frame = app.captureCharFrame()
    expect(frame).toContain("5 hours")
    expect(frame).toContain("42% used")
    expect(frame).toContain("Weekly")
    expect(frame).toContain("18% used")
    expect(frame).toContain("Monthly (total)")
    expect(frame).toContain("7% used")
    expect(frame).toContain("Acme")
    expect(frame).toContain("resets")

    command(harness, "Refresh usage")
    await waitFor(app, () => harness.listCalls() === 2, "refresh did not reload usage")
    command(harness, "Close usage")
    await waitFor(app, () => harness.dialogEntry() === undefined, "dialog did not close")
  } finally {
    app.renderer.destroy()
  }
})

test("renders multiple accounts, including inactive and unsubscribed ones", async () => {
  const personal: AccountUsage = {
    id: "cred_personal",
    label: "Personal",
    active: false,
    state: "not_subscribed",
    workspace: { id: "org_personal", name: "Beta" },
  }
  const harness = createHarness({ accounts: [account, personal] })
  const app = await render(harness)
  try {
    harness.open()
    await waitFor(app, () => app.captureCharFrame().includes("Personal"), "second account was not shown")
    const frame = app.captureCharFrame()
    expect(frame).toContain("Work (active)")
    expect(frame).toContain("Personal")
    expect(frame).toContain("Beta")
    expect(frame).toContain("No OpenCode Go subscription")
  } finally {
    app.renderer.destroy()
  }
})

test("renders an account error without hiding the dialog", async () => {
  const harness = createHarness({ reject: true })
  const app = await render(harness)
  try {
    harness.open()
    await waitFor(app, () => app.captureCharFrame().includes("usage unavailable"), "error was not shown")
    expect(harness.dialogEntry()).toBeDefined()
  } finally {
    app.renderer.destroy()
  }
})

test("renders the empty state when no Go accounts exist", async () => {
  const harness = createHarness({ accounts: [] })
  const app = await render(harness)
  try {
    harness.open()
    await waitFor(app, () => app.captureCharFrame().includes("No OpenCode Go accounts found"), "empty state was not shown")
  } finally {
    app.renderer.destroy()
  }
})
