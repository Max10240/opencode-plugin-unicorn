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
import { parseQuery } from "../../src/query.js"

const theme = {
  text: { base: "#ffffff", muted: "#aaaaaa", formfield: { base: "#ffffff" } },
  background: { raised: { high: "#333333" } },
  border: { base: "#444444" },
  formfield: { base: "#ffffff" },
  surface: () => theme,
}

const now = Date.now()

const entries: PromptEntry[] = [
  {
    sessionID: "s1",
    messageID: "m1",
    text: "first prompt",
    title: "First session",
    directory: "/worktrees/feature-a",
    created: now - 300_000,
    projectID: "p1",
  },
  { sessionID: "s1", messageID: "m2", text: "second prompt", created: now - 240_000, projectID: "p1" },
  { sessionID: "s2", messageID: "m3", text: "third prompt", created: now - 180_000, projectID: "p2" },
]

function createDialogHarness(options: { defaultScope?: "all" | "project"; storedScope?: "all" | "project" } = {}) {
  const inserted: string[] = []
  const copied: string[] = []
  const updates: Array<{ scope: "all" | "project" }> = []
  const stored = { scope: (options.storedScope ?? options.defaultScope ?? "all") as "all" | "project" }
  const layers: Array<{ commands: Array<{ bind?: string; title?: string; run: () => void }> }> = []
  const [dialog, setDialog] = createSignal<{ render: () => JSX.Element } | undefined>()
  const composer = { insertText: (text: string) => { inserted.push(text) }, focus() {} } as any
  const context = {
    options: { defaultScope: options.defaultScope ?? "all" },
    theme,
    keymap: { layer: (factory: () => any) => { layers.push(factory()) } },
    data: { session: { get: () => ({ projectID: "p1" }) } },
    storage: {
      store: () => [stored, async (mutation: (draft: { scope: "all" | "project" }) => void) => {
        mutation(stored)
        updates.push({ ...stored })
      }],
    },
    ui: {
      dialog: { clear() { setDialog(undefined) }, show(render: () => JSX.Element) { setDialog({ render }) }, set() {} },
      router: { current: () => ({ type: "session", sessionID: "s1" }) },
      toast: { show() {} },
    },
    renderer: {
      currentFocusedEditor: composer,
      copyToClipboardOSC52: (text: string) => { copied.push(text); return true },
    },
  } as unknown as Context
  const indexer = {
    searchPage: (query: string, _limit?: number, options?: { projectID?: string; scope?: "all" | "project" }) => {
      const matches = entries.filter((entry) =>
        entry.text.includes(query.toLowerCase()) &&
        (options?.scope !== "project" || entry.projectID === options.projectID))
      return { entries: matches, total: matches.length, query: parseQuery(query) }
    },
    refresh: async () => {},
  } as any
  return { context, indexer, composer, inserted, copied, updates, stored: () => stored, layers, dialog, show() {
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
    await waitFor(app, () => app.captureCharFrame().includes("third prompt"), "all prompts were not listed")
    command(harness, "Next prompt")
    command(harness, "Next prompt")
    command(harness, "Use prompt")
    expect(harness.inserted).toEqual(["third prompt"])
    expect(harness.dialog()).toBeUndefined()
  } finally {
    app.renderer.destroy()
  }
})

test("toggles between all projects and the current project", async () => {
  const harness = createDialogHarness()
  const app = await render(harness)
  try {
    harness.show()
    await waitFor(app, () => app.captureCharFrame().includes("Search previous prompts"), "prompt search dialog did not render")
    await Bun.sleep(20)
    findInput(app.renderer.root)!.value = "prompt"
    await waitFor(app, () => app.captureCharFrame().includes("third prompt"), "all prompts were not listed")
    expect(app.captureCharFrame()).toContain("all projects")

    command(harness, "Toggle prompt scope")
    await waitFor(app, () => app.captureCharFrame().includes("current project"), "current project scope did not render")
    expect(app.captureCharFrame()).not.toContain("third prompt")
    expect(app.captureCharFrame()).toContain("first prompt")

    command(harness, "Toggle prompt scope")
    await waitFor(app, () => app.captureCharFrame().includes("third prompt"), "all-project results did not return")
    expect(app.captureCharFrame()).toContain("all projects")
  } finally {
    app.renderer.destroy()
  }
})

test("shows preview and relative time, copies the prompt and details, and opens help", async () => {
  const harness = createDialogHarness()
  const app = await render(harness)
  try {
    harness.show()
    await waitFor(app, () => app.captureCharFrame().includes("Search previous prompts"), "prompt search dialog did not render")
    await Bun.sleep(20)
    findInput(app.renderer.root)!.value = "prompt"
    await waitFor(app, () => app.captureCharFrame().includes("1. prompt"), "prompt metadata did not render")
    const frame = app.captureCharFrame()
    expect(frame).toContain("Preview")
    expect(frame).toContain("5m ago")
    expect(frame).toContain("first prompt")
    expect(frame).toMatch(/─{40,}/)

    const commands = harness.layers.flatMap((layer) => layer.commands)
    expect(commands.find((item) => item.title === "Toggle prompt scope")?.bind).toBe("ctrl+p")
    expect(commands.find((item) => item.title === "Copy prompt")?.bind).toBe("ctrl+y")
    expect(commands.find((item) => item.title === "Copy prompt details")?.bind).toBe("ctrl+shift+y,alt+y")
    expect(commands.find((item) => item.title === "Focus prompt results")?.bind).toBe("tab")
    expect(commands.some((item) => item.title === "Toggle prompt help" && item.bind === "f1")).toBe(true)
    expect(commands.some((item) => item.title === "Toggle prompt help" && item.bind === "?")).toBe(true)

    command(harness, "Copy prompt")
    expect(harness.copied).toEqual(["first prompt"])
    await waitFor(app, () => app.captureCharFrame().includes("Copied prompt"), "copy confirmation did not appear")

    command(harness, "Copy prompt details")
    expect(JSON.parse(harness.copied.at(-1)!)).toEqual({
      prompt: "first prompt",
      sessionID: "s1",
      messageID: "m1",
      projectID: "p1",
      directory: "/worktrees/feature-a",
      title: "First session",
      created: now - 300_000,
      createdAt: new Date(now - 300_000).toISOString(),
    })
    await waitFor(app, () => app.captureCharFrame().includes("Copied prompt details"), "detail copy confirmation did not appear")

    command(harness, "Toggle prompt help")
    await waitFor(app, () => app.captureCharFrame().includes("close help"), "help panel did not open")
    command(harness, "Toggle prompt help")
    await waitFor(app, () => !app.captureCharFrame().includes("close help"), "help panel did not close")
  } finally {
    app.renderer.destroy()
  }
})

test("starts in the configured default scope when no preference exists", async () => {
  const harness = createDialogHarness({ defaultScope: "project" })
  const app = await render(harness)
  try {
    harness.show()
    await waitFor(app, () => app.captureCharFrame().includes("Search previous prompts"), "prompt search dialog did not render")
    await Bun.sleep(20)
    findInput(app.renderer.root)!.value = "prompt"
    await waitFor(app, () => app.captureCharFrame().includes("first prompt"), "project-scoped prompts did not render")
    expect(app.captureCharFrame()).toContain("current project")
    expect(app.captureCharFrame()).not.toContain("third prompt")
  } finally {
    app.renderer.destroy()
  }
})

test("remembers the last project scope across dialog instances", async () => {
  const harness = createDialogHarness()
  const app = await render(harness)
  try {
    harness.show()
    await waitFor(app, () => app.captureCharFrame().includes("Search previous prompts"), "prompt search dialog did not render")
    await Bun.sleep(20)
    findInput(app.renderer.root)!.value = "prompt"
    await waitFor(app, () => app.captureCharFrame().includes("third prompt"), "all prompts were not listed")

    command(harness, "Toggle prompt scope")
    await waitFor(app, () => app.captureCharFrame().includes("current project"), "current project scope did not render")
    await waitFor(app, () => harness.updates.length === 1, "scope preference was not stored")
    expect(harness.stored().scope).toBe("project")
    expect(harness.updates.at(-1)).toEqual({ scope: "project" })

    command(harness, "Close prompt search")
    await waitFor(app, () => harness.dialog() === undefined, "prompt search did not close")
    harness.show()
    await waitFor(app, () => app.captureCharFrame().includes("Search previous prompts"), "prompt search did not reopen")
    await Bun.sleep(20)
    findInput(app.renderer.root)!.value = "prompt"
    await waitFor(app, () => app.captureCharFrame().includes("first prompt"), "remembered project results did not render")
    expect(app.captureCharFrame()).toContain("current project")
    expect(app.captureCharFrame()).not.toContain("third prompt")
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
