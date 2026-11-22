/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { InputRenderable, type Renderable, TextareaRenderable } from "@opentui/core"
import { testRender } from "@opentui/solid"
import type { Context } from "@opencode/plugin/tui/context"
import { createSignal } from "solid-js"
import type { JSX } from "solid-js"
import { setupNotepadTui } from "../../src/tui.js"
import { MAX_GOAL_BYTES, type Goal, type Note, type NoteScope } from "../../src/types.js"

type Harness = Awaited<ReturnType<typeof createHarness>>

const theme = {
  text: {
    base: "#ffffff",
    muted: "#aaaaaa",
    formfield: { base: "#ffffff" },
    action: { primary: { focused: "#00ffff", disabled: "#555555" } },
  },
  background: { raised: { high: "#333333" } },
  formfield: { base: "#ffffff" },
  surface: () => theme,
}

function createHarness(options: {
  defaultSort?: "created" | "updated"
  initialNotes?: Note[]
  initialGoal?: Goal
  sessionID?: string
  directory?: string
} = {}) {
  const directory = options.directory ?? "/workspace"
  const sessionID = options.sessionID ?? "session-1"
  let notes: Note[] = [...(options.initialNotes ?? [])]
  let goal: Goal | undefined = options.initialGoal
  let nextID = 0
  let clock = 1_000
  const toasts: string[] = []
  const clipboard: string[] = []
  const updates: Array<{ sort: "created" | "updated" }> = []
  const stored = { sort: options.defaultSort ?? "updated" as "created" | "updated" }
  const layers: Array<{ mode: string; target?: () => Renderable | undefined; enabled?: () => boolean; commands: Array<{ bind?: string; title?: string; enabled?: boolean | (() => boolean); run: () => void }> }> = []
  const [dialog, setDialog] = createSignal<{ render: () => JSX.Element } | undefined>()
  const setDialogRender = (render: (() => JSX.Element) | undefined) => {
    setDialog(render ? { render } : undefined)
  }
  const visible = () => notes.filter((note) =>
    note.scope === "global" ||
    (note.scope === "folder" && note.folder === directory) ||
    (note.scope === "session" && note.session === sessionID)
  )
  const scopedNote = (input: { id: string; text: string; scope: NoteScope; directory: string; session?: string; pinned?: boolean; createdAt: number; updatedAt: number }): Note => ({
    id: input.id,
    text: input.text,
    scope: input.scope,
    ...(input.scope === "folder" ? { folder: input.directory } : {}),
    ...(input.scope === "session" ? { session: input.session } : {}),
    ...(input.pinned ? { pinned: true } : {}),
    createdAt: input.createdAt,
    updatedAt: input.updatedAt,
  })
  const goalFor = (note: Note): Goal => ({
    noteID: note.id,
    text: note.text,
    scope: note.scope === "session" ? "session" : "folder",
    ...(note.folder === undefined ? {} : { folder: note.folder }),
    ...(note.session === undefined ? {} : { session: note.session }),
    updatedAt: ++clock,
  })

  const context = {
    options: options.defaultSort ? { defaultSort: options.defaultSort } : {},
    location: { directory },
    storage: {
      store: () => [stored, async (mutation: (draft: { sort: "created" | "updated" }) => void) => {
        mutation(stored)
        updates.push({ ...stored })
      }],
    },
    client: {
      rpc: () => ({
        list: async () => ({ notes: visible().map((note) => ({ ...note })), ...(goal ? { goal: { ...goal } } : {}) }),
        add: async (input: { text: string; scope: NoteScope; directory: string; session?: string; pinned?: boolean }) => {
          const now = ++clock
          const note = scopedNote({ id: `note-${++nextID}`, text: input.text, scope: input.scope, directory: input.directory, session: input.session, pinned: input.pinned, createdAt: now, updatedAt: now })
          notes = [...notes, note]
          return { note }
        },
        update: async (input: { id: string; text: string }) => {
          notes = notes.map((note) => note.id === input.id ? { ...note, text: input.text, updatedAt: ++clock } : note)
          const note = notes.find((item) => item.id === input.id)!
          let goalCleared = false
          if (goal?.noteID === note.id) {
            if (Buffer.byteLength(input.text, "utf8") > MAX_GOAL_BYTES) {
              goal = undefined
              goalCleared = true
            } else {
              goal = { ...goal, text: input.text, updatedAt: note.updatedAt }
            }
          }
          return { note, ...(goalCleared ? { goalCleared: true } : {}) }
        },
        setPinned: async (input: { id: string; pinned: boolean }) => {
          notes = notes.map((note) => note.id === input.id ? { ...note, pinned: input.pinned, updatedAt: ++clock } : note)
          return { note: notes.find((note) => note.id === input.id) }
        },
        remove: async (input: { id: string }) => {
          notes = notes.filter((note) => note.id !== input.id)
          if (goal?.noteID === input.id) goal = undefined
        },
        setGoal: async (input: { sessionID: string; noteID: string; directory: string }) => {
          const note = notes.find((item) => item.id === input.noteID)
          if (!note) throw new Error("Note not found")
          if (note.scope === "global") throw new Error("Global notes cannot be a session goal")
          goal = goalFor(note)
          return { goal }
        },
        clearGoal: async () => {
          const cleared = goal !== undefined
          goal = undefined
          return { cleared }
        },
      }),
      session: { get: async () => ({ location: { directory } }) },
    },
    theme,
    renderer: { copyToClipboardOSC52: (text: string) => { clipboard.push(text); return true } },
    keymap: { layer: (factory: () => any) => { layers.push(factory()) } },
    ui: {
      router: { current: () => ({ type: "session", sessionID }) },
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
  return { context, layers, toasts, clipboard, updates, stored: () => stored, notes: () => notes, goal: () => goal, dialog, setDialogRender }
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

// InputRenderable extends TextareaRenderable, so a plain instance search would
// return the search box before the quick create box.
function findTextarea(root: Renderable): TextareaRenderable | undefined {
  if (root instanceof TextareaRenderable && !(root instanceof InputRenderable)) return root
  for (const child of root.getChildren()) {
    const found = findTextarea(child)
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

function commands(harness: Harness, title: string) {
  return harness.layers.flatMap((layer) => layer.commands).filter((command) => command.title === title)
}

function command(harness: Harness, title: string) {
  const selected = commands(harness, title).at(-1)
  if (!selected) throw new Error(`Missing command: ${title}`)
  selected.run()
}

test("defaults to the current session and creates from the quick create box", async () => {
  const harness = createHarness()
  const app = await render(harness)
  try {
    command(harness, "Open notepad")
    await waitFor(app, () => app.captureCharFrame().includes("No notes in Current Session yet"), "notepad did not open")
    expect(app.captureCharFrame()).toContain("Search in Current Session")
    expect(app.captureCharFrame()).toContain("New note in Current Session")
    expect(app.captureCharFrame()).toContain("ctrl+a Current Session")
    expect(app.captureCharFrame()).not.toContain("New note panel")

    const draft = findTextarea(app.renderer.root)!
    await Bun.sleep(60)
    draft.setText("Session note")
    await app.flush()
    command(harness, "Create note")
    await waitFor(app, () => app.captureCharFrame().includes("Session note"), "note was not created")
    expect(harness.dialog()?.render).toBeDefined()
    expect(harness.notes()).toHaveLength(1)
    expect(harness.notes()[0]).toMatchObject({ text: "Session note", scope: "session", session: "session-1" })
    expect(app.captureCharFrame()).toContain("session ·")
    expect(app.captureCharFrame()).not.toContain("Edit note")
    expect(draft.plainText).toBe("")
  } finally {
    app.renderer.destroy()
  }
})

test("tab only switches the two inputs and search enter is intentionally unbound", async () => {
  const harness = createHarness()
  const app = await render(harness)
  try {
    command(harness, "Open notepad")
    await waitFor(app, () => app.captureCharFrame().includes("No notes in Current Session yet"), "notepad did not open")

    expect(commands(harness, "Edit selected note")).toEqual([])
    expect(commands(harness, "Create note").map((entry) => entry.bind)).toEqual(["return"])
    expect(commands(harness, "Insert new line").map((entry) => entry.bind)).toEqual(["shift+return"])
    expect(commands(harness, "Focus new note").map((entry) => entry.bind)).toEqual(expect.arrayContaining(["tab", "shift+tab"]))
    expect(commands(harness, "Focus search").map((entry) => entry.bind)).toEqual(expect.arrayContaining(["tab", "shift+tab"]))
    expect(commands(harness, "Focus notes")).toEqual([])

    const draft = findTextarea(app.renderer.root)!
    await Bun.sleep(60)
    draft.setText("Editable note")
    command(harness, "Create note")
    await waitFor(app, () => app.captureCharFrame().includes("Editable note"), "note was not created")

    command(harness, "Edit note")
    await waitFor(app, () => app.captureCharFrame().includes("Edit note"), "ctrl+e did not open the editor")
    command(harness, "Cancel note")
    await waitFor(app, () => app.captureCharFrame().includes("Search in Current Session"), "cancel did not return to the list")
  } finally {
    app.renderer.destroy()
  }
})

test("Ctrl+A switches scope without resetting typed state and scopes creation", async () => {
  const harness = createHarness()
  const app = await render(harness)
  try {
    command(harness, "Open notepad")
    await waitFor(app, () => app.captureCharFrame().includes("No notes in Current Session yet"), "notepad did not open")
    const search = find(app.renderer.root, InputRenderable)!
    const draft = findTextarea(app.renderer.root)!
    search.value = "note"
    await Bun.sleep(60)
    draft.setText("unfinished draft")
    await app.flush()

    command(harness, "Switch note scope")
    await waitFor(app, () => app.captureCharFrame().includes("ctrl+a Current Directory"), "scope did not switch to the directory")
    expect(search.placeholder).toBe("Search in Current Directory")
    expect(draft.placeholder).toBe("New note in Current Directory")
    expect(search.value).toBe("note")
    expect(draft.plainText).toBe("unfinished draft")

    command(harness, "Switch note scope")
    await waitFor(app, () => app.captureCharFrame().includes("ctrl+a Global"), "scope did not switch to global")
    expect(search.placeholder).toBe("Search in Global")
    expect(draft.placeholder).toBe("New note in Global")
    expect(search.value).toBe("note")
    expect(draft.plainText).toBe("unfinished draft")

    draft.setText("Global note")
    await app.flush()
    command(harness, "Create note")
    await waitFor(app, () => app.captureCharFrame().includes("Global note"), "global note was not created")
    expect(harness.notes()[0]).toMatchObject({ text: "Global note", scope: "global" })

    command(harness, "Switch note scope")
    await waitFor(app, () => app.captureCharFrame().includes("ctrl+a Current Session"), "scope did not return to the session")
    expect(app.captureCharFrame()).not.toContain("Global note")

    draft.setText("Session note")
    await app.flush()
    command(harness, "Create note")
    await waitFor(app, () => app.captureCharFrame().includes("Session note"), "session note was not created")
    command(harness, "Switch note scope")
    await waitFor(app, () => app.captureCharFrame().includes("ctrl+a Current Directory"), "scope did not switch back to the directory")
    expect(app.captureCharFrame()).not.toContain("Session note")
  } finally {
    app.renderer.destroy()
  }
})

test("the first note is selected and arrows navigate the list", async () => {
  const harness = createHarness({
    initialNotes: [
      { id: "older", text: "Older note", scope: "session", session: "session-1", createdAt: 1, updatedAt: 1 },
      { id: "newer", text: "Newer note", scope: "session", session: "session-1", createdAt: 2, updatedAt: 2 },
    ],
  })
  const app = await render(harness)
  try {
    command(harness, "Open notepad")
    await waitFor(app, () => app.captureCharFrame().includes("Newer note"), "notes did not render")

    command(harness, "Next note")
    command(harness, "Delete note")
    await waitFor(app, () => app.captureCharFrame().includes("Press ctrl+d again"), "delete confirmation was not shown")
    command(harness, "Delete note")
    await waitFor(app, () => harness.notes().length === 1, "the selected note was not deleted")
    expect(harness.notes().map((note) => note.text)).toEqual(["Newer note"])
  } finally {
    app.renderer.destroy()
  }
})

test("pins notes, changes sort mode, copies, deletes, and restores", async () => {
  const harness = createHarness()
  const app = await render(harness)
  try {
    command(harness, "Open notepad")
    await waitFor(app, () => app.captureCharFrame().includes("No notes in Current Session yet"), "notepad did not open")
    const draft = findTextarea(app.renderer.root)!
    await Bun.sleep(60)
    draft.setText("Recover me")
    command(harness, "Create note")
    await waitFor(app, () => app.captureCharFrame().includes("Recover me"), "note was not created")

    command(harness, "Toggle note pin")
    await waitFor(app, () => app.captureCharFrame().includes("📌 Recover me"), "note was not pinned")
    expect(harness.toasts).toContain("Note pinned")

    command(harness, "Change note sort")
    await waitFor(app, () => harness.updates.length === 1, "sort preference was not stored")
    expect(harness.stored().sort).toBe("created")
    expect(app.captureCharFrame()).toContain("created")

    command(harness, "Copy note")
    expect(harness.clipboard).toEqual(["Recover me"])
    expect(harness.toasts).toContain("Copied note")

    command(harness, "Delete note")
    await waitFor(app, () => app.captureCharFrame().includes("Press ctrl+d again"), "delete confirmation was not shown")
    command(harness, "Delete note")
    await waitFor(app, () => app.captureCharFrame().includes("No notes in Current Session yet"), "note was not deleted")
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

test("goal stays first and outside search, cannot be deleted, and clears with Ctrl+T", async () => {
  const goalNote: Note = { id: "goal", text: "GOAL_MARKER", scope: "session", session: "session-1", createdAt: 1, updatedAt: 1 }
  const harness = createHarness({
    initialNotes: [
      goalNote,
      { id: "other", text: "OTHER_MARKER", scope: "session", session: "session-1", createdAt: 2, updatedAt: 2 },
    ],
    initialGoal: { noteID: "goal", text: "GOAL_MARKER", scope: "session", session: "session-1", updatedAt: 1 },
  })
  const app = await render(harness)
  try {
    command(harness, "Open notepad")
    await waitFor(app, () => app.captureCharFrame().includes("🎯 GOAL_MARKER"), "goal note was not marked")
    const frame = app.captureCharFrame()
    expect(frame.indexOf("GOAL_MARKER")).toBeLessThan(frame.indexOf("OTHER_MARKER"))

    const search = find(app.renderer.root, InputRenderable)!
    search.value = "OTHER"
    await app.flush()
    await waitFor(app, () => app.captureCharFrame().includes("OTHER_MARKER"), "search did not filter the list")
    expect(app.captureCharFrame()).toContain("GOAL_MARKER")

    command(harness, "Delete note")
    await waitFor(app, () => harness.toasts.some((toast) => toast.includes("Goal note cannot be deleted")), "goal deletion was not blocked")
    expect(harness.notes()).toHaveLength(2)
    expect(app.captureCharFrame()).not.toContain("Press ctrl+d again")

    command(harness, "Toggle note goal")
    await waitFor(app, () => harness.goal() === undefined, "ctrl+t did not clear the goal")
    expect(app.captureCharFrame()).not.toContain("🎯 GOAL_MARKER")
    expect(harness.toasts).toContain("Goal cleared")
  } finally {
    app.renderer.destroy()
  }
})

test("Ctrl+T sets a goal and the shortcut is disabled in Global", async () => {
  const harness = createHarness()
  const app = await render(harness)
  try {
    command(harness, "Open notepad")
    await waitFor(app, () => app.captureCharFrame().includes("No notes in Current Session yet"), "notepad did not open")
    const draft = findTextarea(app.renderer.root)!
    await Bun.sleep(60)
    draft.setText("Goal me")
    command(harness, "Create note")
    await waitFor(app, () => app.captureCharFrame().includes("Goal me"), "note was not created")
    const beforeGoal = commands(harness, "Toggle note goal").at(-1)
    expect(typeof beforeGoal?.enabled === "function" ? beforeGoal.enabled() : beforeGoal?.enabled).toBe(true)

    command(harness, "Delete note")
    await waitFor(app, () => app.captureCharFrame().includes("Press ctrl+d again"), "delete confirmation was not shown")
    command(harness, "Toggle note goal")
    await waitFor(app, () => harness.goal()?.text === "Goal me", "ctrl+t did not set the goal")
    await waitFor(app, () => app.captureCharFrame().includes("🎯 Goal me"), "goal marker did not render")
    expect(harness.toasts).toContain("Goal set")
    expect(app.captureCharFrame()).not.toContain("Press ctrl+d again")

    command(harness, "Switch note scope")
    command(harness, "Switch note scope")
    await waitFor(app, () => app.captureCharFrame().includes("ctrl+a Global"), "scope did not reach global")
    const goalCommand = commands(harness, "Toggle note goal").at(-1)
    expect(typeof goalCommand?.enabled === "function" ? goalCommand.enabled() : goalCommand?.enabled).toBe(false)
    expect(app.captureCharFrame()).toContain("🎯 Goal me")
    expect(app.captureCharFrame()).toContain("goal · session")
  } finally {
    app.renderer.destroy()
  }
})

test("editing a goal note updates it or clears the goal when it exceeds 8 KiB", async () => {
  const harness = createHarness()
  const app = await render(harness)
  try {
    command(harness, "Open notepad")
    await waitFor(app, () => app.captureCharFrame().includes("No notes in Current Session yet"), "notepad did not open")
    const search = find(app.renderer.root, InputRenderable)!
    const draft = findTextarea(app.renderer.root)!
    search.value = "note"
    await Bun.sleep(60)
    draft.setText("Goal note")
    await app.flush()
    command(harness, "Create note")
    await waitFor(app, () => app.captureCharFrame().includes("Goal note"), "note was not created")
    command(harness, "Toggle note goal")
    await waitFor(app, () => harness.goal()?.text === "Goal note", "goal was not set")

    findTextarea(app.renderer.root)!.setText("draft kept")
    await app.flush()
    command(harness, "Edit note")
    await waitFor(app, () => app.captureCharFrame().includes("Edit note"), "editor did not open")
    await Bun.sleep(60)
    findTextarea(app.renderer.root)!.setText("Updated goal")
    command(harness, "Save note")
    await waitFor(app, () => app.captureCharFrame().includes("Updated goal"), "updated goal was not listed")
    expect(harness.goal()?.text).toBe("Updated goal")
    expect(find(app.renderer.root, InputRenderable)!.value).toBe("note")
    expect(findTextarea(app.renderer.root)!.plainText).toBe("draft kept")

    command(harness, "Edit note")
    await waitFor(app, () => app.captureCharFrame().includes("Edit note"), "editor did not open again")
    await Bun.sleep(60)
    findTextarea(app.renderer.root)!.setText("x".repeat(MAX_GOAL_BYTES + 1))
    command(harness, "Save note")
    await waitFor(app, () => harness.goal() === undefined, "oversized edit did not clear the goal")
    expect(harness.toasts).toContain("Goal cleared: note exceeds 8 KiB")
  } finally {
    app.renderer.destroy()
  }
})

test("does not bind printable single-character shortcuts", async () => {
  const harness = createHarness()
  const app = await render(harness)
  try {
    command(harness, "Open notepad")
    await waitFor(app, () => app.captureCharFrame().includes("No notes in Current Session yet"), "notepad did not open")
    const bindings = harness.layers.flatMap((layer) => layer.commands)
    expect(bindings.filter((item) => item.bind && /^(?:shift\+)?[a-z?0-9]$/i.test(item.bind))).toEqual([])
    expect(bindings.filter((item) => item.title === "Switch note scope").map((item) => item.bind)).toEqual(["ctrl+a"])
    expect(bindings.filter((item) => item.title === "Toggle note goal").map((item) => item.bind)).toEqual(["ctrl+t"])
  } finally {
    app.renderer.destroy()
  }
})

test("shows an error instead of opening notes without a project directory", async () => {
  const harness = createHarness()
  ;(harness.context as any).location = undefined
  ;(harness.context as any).client.session = { get: async () => ({}) }
  const app = await render(harness)
  try {
    command(harness, "Open notepad")
    await waitFor(app, () => harness.toasts.includes("Open a project folder first"), "missing folder warning was not shown")
    expect(app.captureCharFrame()).not.toContain("No notes in Current Session yet")
  } finally {
    app.renderer.destroy()
  }
})
