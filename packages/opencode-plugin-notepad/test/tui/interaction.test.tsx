/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { InputRenderable, type Renderable, TextareaRenderable } from "@opentui/core"
import { testRender } from "@opentui/solid"
import type { Context } from "@opencode/plugin/tui/context"
import { createSignal } from "solid-js"
import type { JSX } from "solid-js"
import { setupNotepadTui } from "../../src/tui.js"
import type { Note, NoteScope } from "../../src/types.js"

type Harness = Awaited<ReturnType<typeof createHarness>>

const theme = {
  text: { base: "#ffffff", muted: "#aaaaaa", formfield: { base: "#ffffff" } },
  background: { raised: { high: "#333333" } },
  formfield: { base: "#ffffff" },
  surface: () => theme,
}

function createHarness(options: { defaultSort?: "created" | "updated" } = {}) {
  let notes: Note[] = []
  let nextID = 0
  const toasts: string[] = []
  const clipboard: string[] = []
  const updates: Array<{ sort: "created" | "updated" }> = []
  const stored = { sort: options.defaultSort ?? "updated" as "created" | "updated" }
  const layers: Array<{ mode: string; target?: () => Renderable | undefined; enabled?: () => boolean; commands: Array<{ bind?: string; title?: string; run: () => void }> }> = []
  const [dialog, setDialog] = createSignal<{ render: () => JSX.Element } | undefined>()
  const setDialogRender = (render: (() => JSX.Element) | undefined) => {
    setDialog(render ? { render } : undefined)
  }

  const context = {
    options: options.defaultSort ? { defaultSort: options.defaultSort } : {},
    location: { directory: "/workspace" },
    storage: {
      store: () => [stored, async (mutation: (draft: { sort: "created" | "updated" }) => void) => {
        mutation(stored)
        updates.push({ ...stored })
      }],
    },
    client: {
      rpc: () => ({
        list: async () => ({ notes: notes.map((note) => ({ ...note })) }),
        add: async (input: { text: string; scope: NoteScope; pinned?: boolean }) => {
          const now = Date.now()
          const note = { id: `note-${++nextID}`, text: input.text, scope: input.scope, ...(input.pinned ? { pinned: true } : {}), createdAt: now, updatedAt: now }
          notes = [...notes, note]
          return { note }
        },
        update: async (input: { id: string; text: string }) => {
          notes = notes.map((note) => note.id === input.id ? { ...note, text: input.text, updatedAt: Date.now() } : note)
        },
        setScope: async (input: { id: string; scope: NoteScope }) => {
          notes = notes.map((note) => note.id === input.id ? { ...note, scope: input.scope, updatedAt: Date.now() } : note)
        },
        setPinned: async (input: { id: string; pinned: boolean }) => {
          notes = notes.map((note) => note.id === input.id ? { ...note, pinned: input.pinned, updatedAt: Date.now() } : note)
          return { note: notes.find((note) => note.id === input.id) }
        },
        remove: async (input: { id: string }) => {
          notes = notes.filter((note) => note.id !== input.id)
        },
      }),
      session: { get: async () => ({ location: { directory: "/workspace" } }) },
    },
    theme,
    renderer: { copyToClipboardOSC52: (text: string) => { clipboard.push(text); return true } },
    keymap: { layer: (factory: () => any) => { layers.push(factory()) } },
    ui: {
      router: { current: () => ({ type: "session", sessionID: "session" }) },
      toast: { show: (input: { message: string }) => { toasts.push(input.message) } },
      dialog: {
        set() {},
        show(render: () => JSX.Element) { setDialogRender(render) },
        clear() { setDialogRender(undefined) },
        alert: async (input: { message: string }) => { toasts.push(input.message) },
        confirm: async () => true,
      },
      format: { path: (value: string) => value },
    },
  } as unknown as Context

  setupNotepadTui(context)
  return { context, layers, toasts, clipboard, updates, stored: () => stored, notes: () => notes, dialog, setDialogRender }
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

function command(harness: Harness, title: string) {
  const layer = [...harness.layers].reverse().find((entry) => entry.commands.some((command) => command.title === title))
  const selected = layer?.commands.find((command) => command.title === title)
  if (!selected) throw new Error(`Missing command: ${title}`)
  selected.run()
}

test("renders notes, filters both scopes, toggles scope, copies, and deletes", async () => {
  const harness = createHarness()
  const app = await render(harness)
  try {
    command(harness, "Open notepad")
    await waitFor(app, () => app.captureCharFrame().includes("No notes yet"), "notepad did not open")
    command(harness, "Add note")
    await waitFor(app, () => app.captureCharFrame().includes("f2 / ctrl+s save"), "note editor did not open")
    await Bun.sleep(60)
    find(app.renderer.root, TextareaRenderable)!.setText("Folder note")
    command(harness, "Save note")
    await waitFor(app, () => app.captureCharFrame().includes("Folder note"), "note was not saved")
    expect(harness.notes()[0]).toMatchObject({ text: "Folder note", scope: "folder" })
    expect(app.captureCharFrame()).toContain("folder ·")

    command(harness, "Toggle note scope")
    await waitFor(app, () => app.captureCharFrame().includes("global ·"), "note scope was not toggled")
    expect(harness.toasts).toContain("Moved to Global")

    command(harness, "Copy note")
    expect(harness.clipboard).toEqual(["Folder note"])
    expect(harness.toasts).toContain("Copied note")

    command(harness, "Search notes")
    const input = find(app.renderer.root, InputRenderable)!
    input.value = "missing"
    await app.flush()
    expect(app.captureCharFrame()).toContain("No notes yet")
    input.value = "folder"
    await app.flush()
    expect(app.captureCharFrame()).toContain("Folder note")
    command(harness, "Back to notes")

    command(harness, "Delete note")
    await waitFor(app, () => app.captureCharFrame().includes("Press ctrl+d again"), "delete confirmation was not shown")
    command(harness, "Delete note")
    await waitFor(app, () => app.captureCharFrame().includes("No notes yet"), "note was not deleted")
    expect(harness.notes()).toEqual([])
  } finally {
    app.renderer.destroy()
  }
})

test("restores the last deleted note", async () => {
  const harness = createHarness()
  const app = await render(harness)
  try {
    command(harness, "Open notepad")
    await waitFor(app, () => app.captureCharFrame().includes("No notes yet"), "notepad did not open")
    command(harness, "Add note")
    await waitFor(app, () => app.captureCharFrame().includes("f2 / ctrl+s save"), "note editor did not open")
    await Bun.sleep(60)
    find(app.renderer.root, TextareaRenderable)!.setText("Recover me")
    command(harness, "Save note")
    await waitFor(app, () => app.captureCharFrame().includes("Recover me"), "note was not saved")
    command(harness, "Toggle note pin")
    await waitFor(app, () => app.captureCharFrame().includes("★ Recover me"), "note was not pinned")

    command(harness, "Delete note")
    await waitFor(app, () => app.captureCharFrame().includes("Press ctrl+d again"), "delete confirmation was not shown")
    command(harness, "Delete note")
    await waitFor(app, () => app.captureCharFrame().includes("No notes yet"), "note was not deleted")
    expect(app.captureCharFrame()).toContain("ctrl+z undo")

    command(harness, "Undo delete")
    await waitFor(app, () => app.captureCharFrame().includes("Recover me"), "note was not restored")
    expect(harness.notes().map((note) => note.text)).toEqual(["Recover me"])
    expect(harness.notes()[0]?.pinned).toBe(true)
    expect(harness.toasts).toContain("Note restored")
  } finally {
    app.renderer.destroy()
  }
})

test("uses defaultSort before a preference is stored", async () => {
  const harness = createHarness({ defaultSort: "created" })
  const app = await render(harness)
  try {
    command(harness, "Open notepad")
    await waitFor(app, () => app.captureCharFrame().includes("No notes yet"), "notepad did not open")
    expect(app.captureCharFrame()).toContain("sort: created")
  } finally {
    app.renderer.destroy()
  }
})

test("pins notes, changes sort mode, exposes explicit editor save keys, and remembers sort", async () => {
  const harness = createHarness()
  const app = await render(harness)
  try {
    command(harness, "Open notepad")
    await waitFor(app, () => app.captureCharFrame().includes("No notes yet"), "notepad did not open")
    command(harness, "Add note")
    await waitFor(app, () => app.captureCharFrame().includes("f2 / ctrl+s save"), "note editor did not open")
    const bindings = harness.layers.flatMap((layer) => layer.commands)
    expect(bindings.filter((item) => item.title === "Toggle note scope").map((item) => item.bind)).toEqual(expect.arrayContaining(["ctrl+g", "ctrl+p"]))
    expect(bindings.some((item) => item.title === "Toggle notepad help" && item.bind === "f1")).toBe(true)
    expect(bindings.filter((item) => item.bind && /^(?:shift\+)?[a-z?0-9]$/i.test(item.bind))).toEqual([])
    expect(harness.layers.flatMap((layer) => layer.commands).filter((entry) => entry.title === "Save note").map((entry) => entry.bind)).toEqual(["f2", "ctrl+s"])
    await Bun.sleep(60)
    find(app.renderer.root, TextareaRenderable)!.setText("Pinned note")
    command(harness, "Save note")
    await waitFor(app, () => app.captureCharFrame().includes("Pinned note"), "note was not saved")

    command(harness, "Toggle note pin")
    await waitFor(app, () => app.captureCharFrame().includes("★ Pinned note"), "note was not pinned")
    expect(app.captureCharFrame()).toContain("Pinned")
    expect(harness.toasts).toContain("Note pinned")

    command(harness, "Change note sort")
    await waitFor(app, () => app.captureCharFrame().includes("sort: created"), "sort mode did not change")
    await waitFor(app, () => harness.updates.length === 1, "sort preference was not stored")
    expect(harness.stored().sort).toBe("created")
    expect(harness.updates.at(-1)).toEqual({ sort: "created" })

    command(harness, "Close notepad")
    await waitFor(app, () => harness.dialog() === undefined, "notepad did not close")
    command(harness, "Open notepad")
    await waitFor(app, () => app.captureCharFrame().includes("Pinned note"), "notepad did not reopen")
    expect(app.captureCharFrame()).toContain("sort: created")
  } finally {
    app.renderer.destroy()
  }
})

test("does not dispatch panel commands while another dialog is open", async () => {
  const harness = createHarness()
  const app = await render(harness)
  try {
    command(harness, "Open notepad")
    await waitFor(app, () => app.captureCharFrame().includes("No notes yet"), "notepad did not open")
    command(harness, "Add note")
    await waitFor(app, () => app.captureCharFrame().includes("f2 / ctrl+s save"), "note editor did not open")
    await Bun.sleep(60)
    const panel = harness.layers.filter((layer) => layer.commands.some((entry) => entry.title === "Add note"))
    expect(panel).toHaveLength(1)
    expect(panel[0].enabled?.()).toBe(false)
    harness.setDialogRender(() => <text>Unrelated dialog</text>)
    await waitFor(app, () => app.captureCharFrame().includes("Unrelated dialog"), "replacement dialog did not render")
  } finally {
    app.renderer.destroy()
  }
})

test("shows an error instead of opening notes without a project directory", async () => {
  const harness = createHarness()
  ;(harness.context as any).location = undefined
  ;(harness.context.client as any).session = { get: async () => ({}) }
  const app = await render(harness)
  try {
    command(harness, "Open notepad")
    await waitFor(app, () => harness.toasts.includes("Open a project folder first"), "missing folder warning was not shown")
    expect(app.captureCharFrame()).not.toContain("No notes yet")
  } finally {
    app.renderer.destroy()
  }
})
