/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { InputRenderable, type Renderable } from "@opentui/core"
import { testRender } from "@opentui/solid"
import type { Context } from "@opencode/plugin/tui/context"
import { createSignal } from "solid-js"
import type { JSX } from "solid-js"
import { PromptSearchDialog } from "../../src/dialog.js"
import { setupPromptSearch, COMMAND_ID } from "../../src/tui.js"
import type { PromptEntry } from "../../src/indexer.js"

const theme = {
  text: { base: "#ffffff", muted: "#aaaaaa", formfield: { base: "#ffffff" } },
  background: { raised: { high: "#333333" } },
  formfield: { base: "#ffffff" },
  surface: () => theme,
}

const entries: PromptEntry[] = [
  { sessionID: "s1", messageID: "m1", text: "first prompt", created: 3 },
  { sessionID: "s1", messageID: "m2", text: "second prompt", created: 2 },
  { sessionID: "s2", messageID: "m3", text: "third prompt", created: 1 },
]

function createDialogHarness() {
  const inserted: string[] = []
  const layers: Array<{ commands: Array<{ bind?: string; title?: string; run: () => void }> }> = []
  const [dialog, setDialog] = createSignal<{ render: () => JSX.Element } | undefined>()
  const composer = { insertText: (text: string) => { inserted.push(text) }, focus() {} } as any
  const context = {
    theme,
    keymap: { layer: (factory: () => any) => { layers.push(factory()) } },
    ui: {
      dialog: { clear() { setDialog(undefined) }, show(render: () => JSX.Element) { setDialog({ render }) }, set() {} },
      router: { current: () => ({ type: "session", sessionID: "s1" }) },
      toast: { show() {} },
    },
    renderer: { currentFocusedEditor: composer },
  } as unknown as Context
  const indexer = {
    search: (query: string) => entries.filter((entry) => entry.text.includes(query.toLowerCase())),
    refresh: async () => {},
  } as any
  return { context, indexer, composer, inserted, layers, dialog, show() {
    setDialog({ render: () => <PromptSearchDialog context={context} indexer={indexer} composer={composer} /> })
  } }
}

async function render(harness: ReturnType<typeof createDialogHarness>) {
  return testRender(() => (
    <box width="100%" height="100%">
      {(() => { const entry = harness.dialog(); return entry ? entry.render() : null })()}
    </box>
  ), { width: 100, height: 30 })
}

function command(harness: ReturnType<typeof createDialogHarness>, title: string) {
  const layer = [...harness.layers].reverse().find((entry) => entry.commands.some((command) => command.title === title))
  const selected = layer?.commands.find((command) => command.title === title)
  if (!selected) throw new Error(`Missing command: ${title}`)
  selected.run()
}

function findInput(root: Renderable): InputRenderable | undefined {
  if (root instanceof InputRenderable) return root
  for (const child of root.getChildren()) {
    const found = findInput(child)
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

test("filters prompts, moves the selection and inserts the chosen prompt", async () => {
  const harness = createDialogHarness()
  const app = await render(harness)
  try {
    harness.show()
    await waitFor(app, () => app.captureCharFrame().includes("Search previous prompts"), "prompt search dialog did not render")
    await Bun.sleep(20)
    const input = findInput(app.renderer.root)!
    input.value = "prompt"
    await waitFor(app, () => app.captureCharFrame().includes("3. third prompt"), "all prompts were not listed")
    command(harness, "Next prompt")
    command(harness, "Next prompt")
    command(harness, "Use prompt")
    expect(harness.inserted).toEqual(["third prompt"])
    expect(harness.dialog()).toBeUndefined()
  } finally {
    app.renderer.destroy()
  }
})

test("shows an empty state and closes without inserting", async () => {
  const harness = createDialogHarness()
  const app = await render(harness)
  try {
    harness.show()
    await waitFor(app, () => app.captureCharFrame().includes("Search previous prompts"), "prompt search dialog did not render")
    await Bun.sleep(20)
    findInput(app.renderer.root)!.value = "missing"
    await waitFor(app, () => app.captureCharFrame().includes("No matching prompts"), "empty state did not render")
    command(harness, "Close prompt search")
    expect(harness.dialog()).toBeUndefined()
    expect(harness.inserted).toEqual([])
  } finally {
    app.renderer.destroy()
  }
})

test("registers only when enabled and requires an active session", async () => {
  let route: any = { type: "home" }
  const toasts: string[] = []
  const commands: any[] = []
  const context = {
    options: {},
    client: { session: { list: async () => ({ data: [], cursor: {} }), export: async () => ({ messages: [] }), inbox: { list: async () => [] } } },
    storage: { store: () => [{ version: 1, sessions: {} }, async () => {}] },
    data: { listen: () => () => {} },
    renderer: { currentFocusedEditor: { insertText() {}, focus() {} } },
    keymap: { layer: (factory: () => any) => commands.push(...factory().commands) },
    ui: {
      router: { current: () => route },
      toast: { show: (value: { message: string }) => toasts.push(value.message) },
      dialog: { show() {}, clear() {} },
      slot: (claim: { render: () => unknown }) => { claim.render(); return () => {} },
    },
  } as unknown as Context
  const stop = setupPromptSearch(context)
  const open = commands.find((command) => command.id === COMMAND_ID)
  expect(open.bind).toBe("ctrl+shift+r")
  open.run()
  expect(toasts).toContain("Open a session first")
  route = { type: "session", sessionID: "s1" }
  open.run()
  stop()

})
