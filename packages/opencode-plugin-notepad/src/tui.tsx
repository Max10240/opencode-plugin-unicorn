import { Plugin } from "@opencode/plugin/tui"
import type { Context } from "@opencode/plugin/tui/context"
import { TextAttributes, type InputRenderable, type ScrollBoxRenderable, type TextareaRenderable } from "@opentui/core"
import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js"
import { NotepadRpc } from "./rpc.js"
import { MAX_GOAL_BYTES, type Goal, type Note, type NoteScope } from "./types.js"

export const DEFAULT_KEYBIND = "ctrl+shift+n"
export const COMMAND_ID = "max10240.notepad.open"

type NoteResult = { notes: Note[]; goal?: Goal }
type NoteSort = "updated" | "created"
type Focus = "search" | "create"
type PanelState = {
  readonly selected?: string
  readonly query?: string
  readonly draft?: string
  readonly scope?: NoteScope
  readonly focus?: Focus
}

const SCOPES: readonly NoteScope[] = ["session", "folder", "global"]

// One recoverable deletion per folder and session, kept until the next delete or undo.
const deletedNotes = new Map<string, Note>()

export default Plugin.define({
  id: "max10240.notepad.tui",
  setup: setupNotepadTui,
})

export function setupNotepadTui(context: Context) {
  if (context.options.enabled === false) return
  const keybind = resolveKeybind(context.options.keybind)
  context.keymap.layer(() => ({
    mode: "global",
    priority: 10,
    commands: [{
      id: COMMAND_ID,
      title: "Open notepad",
      description: "Capture and manage session, folder, and global notes",
      group: "Notes",
      bind: keybind,
      palette: true,
      slash: { name: "notepad" },
      run: () => void openNotepad(context),
    }],
  }))
}

export function resolveKeybind(value: unknown): string | false {
  if (value === false) return false
  return typeof value === "string" && value.trim() ? value.trim() : DEFAULT_KEYBIND
}

export function scopeLabel(scope: NoteScope) {
  if (scope === "session") return "Current Session"
  if (scope === "folder") return "Current Directory"
  return "Global"
}

function scopeShort(scope: NoteScope) {
  if (scope === "session") return "session"
  if (scope === "folder") return "directory"
  return "global"
}

async function openNotepad(context: Context) {
  const target = await currentTarget(context)
  if (!target) {
    void context.ui.toast.show({ message: "Open a project folder first", variant: "warning" })
    return
  }
  await openList(context, target)
}

async function currentTarget(context: Context): Promise<{ directory: string; sessionID?: string } | undefined> {
  const route = context.ui.router.current()
  if (route.type === "session") {
    try {
      const session = await context.client.session.get({ sessionID: route.sessionID })
      const directory = session?.location?.directory
      if (typeof directory === "string" && directory) return { directory, sessionID: route.sessionID }
    } catch {}
    if (context.location?.directory) return { directory: context.location.directory, sessionID: route.sessionID }
  }
  return context.location?.directory ? { directory: context.location.directory } : undefined
}

async function fetchList(context: Context, target: { directory: string; sessionID?: string }) {
  return await context.client.rpc(NotepadRpc).list(
    { directory: target.directory, ...(target.sessionID === undefined ? {} : { session: target.sessionID }) },
    { location: context.location },
  ) as NoteResult
}

async function openList(
  context: Context,
  target: { directory: string; sessionID?: string },
  state: PanelState = {},
) {
  let result: NoteResult
  try {
    result = await fetchList(context, target)
  } catch (error) {
    await context.ui.dialog.alert({ title: "Notepad", message: message(error) })
    return
  }
  context.ui.dialog.show(() => (
    <NotepadList context={context} target={target} initial={result.notes} initialGoal={result.goal} state={state} />
  ))
}

function NotepadList(props: {
  context: Context
  target: { directory: string; sessionID?: string }
  initial: Note[]
  initialGoal?: Goal
  state: PanelState
}) {
  const [notes, setNotes] = createSignal(props.initial)
  const [goal, setGoal] = createSignal<Goal | undefined>(props.initialGoal)
  const [query, setQuery] = createSignal(props.state.query ?? "")
  const [draft, setDraft] = createSignal(props.state.draft ?? "")
  const [selected, setSelected] = createSignal<string | undefined>(props.state.selected)
  const [listTarget, setListTarget] = createSignal<ScrollBoxRenderable>()
  const [searchTarget, setSearchTarget] = createSignal<InputRenderable>()
  const [createTarget, setCreateTarget] = createSignal<TextareaRenderable>()
  const [help, setHelp] = createSignal(false)
  const [pendingDelete, setPendingDelete] = createSignal<string>()
  const [focus, setFocus] = createSignal<Focus>(props.state.focus ?? "search")
  const theme = props.context.theme.surface("dialog")
  const formBackground = theme.background?.formfield?.base ?? theme.background?.base
  const formFocusedBackground = theme.background?.formfield?.focused ?? theme.background?.raised?.high
  const formFocusedText = theme.text?.formfield?.focused ?? theme.text.formfield.base
  const accent = theme.text?.action?.primary?.focused ?? theme.text.base
  const disabled = theme.text?.action?.primary?.disabled ?? theme.text.muted
  const border = theme.border
  const borderMuted = (border && typeof border === "object" && "base" in border ? border.base : border) ?? theme.text.muted
  const defaultSort: NoteSort = props.context.options.defaultSort === "created" ? "created" : "updated"
  const storage = (() => {
    try {
      return props.context.storage.store<{ sort: NoteSort }>("notepad.preferences", { initial: { sort: defaultSort } })
    } catch {
      return undefined
    }
  })()
  const [stored, updateStored] = storage ?? [{ sort: defaultSort }, () => {}]
  const [sort, setSort] = createSignal<NoteSort>(stored.sort === "created" || stored.sort === "updated" ? stored.sort : defaultSort)
  const scopes = createMemo<readonly NoteScope[]>(() =>
    props.target.sessionID === undefined ? SCOPES.filter((value) => value !== "session") : SCOPES
  )
  const [scope, setScope] = createSignal<NoteScope>(
    props.state.scope && scopes().includes(props.state.scope) ? props.state.scope : scopes()[0] ?? "folder",
  )
  const undoKey = `${props.target.directory}\u0000${props.target.sessionID ?? ""}`
  const ordered = (values: readonly Note[]) => values.slice().sort((left, right) =>
    Number(right.pinned === true) - Number(left.pinned === true) ||
    (sort() === "created" ? right.createdAt - left.createdAt : right.updatedAt - left.updatedAt)
  )
  const goalNote = createMemo<Note | undefined>(() => {
    const current = goal()
    if (!current) return
    return notes().find((note) => note.id === current.noteID) ?? {
      id: current.noteID,
      text: current.text,
      scope: current.scope,
      ...(current.folder === undefined ? {} : { folder: current.folder }),
      ...(current.session === undefined ? {} : { session: current.session }),
      createdAt: current.updatedAt,
      updatedAt: current.updatedAt,
    }
  })
  const scoped = createMemo(() => notes().filter((note) => note.scope === scope()))
  const entries = createMemo(() => {
    const value = query().trim().toLowerCase()
    const first = goalNote()
    const rest = ordered(
      scoped()
        .filter((note) => note.id !== first?.id)
        .filter((note) => !value || note.text.toLowerCase().includes(value)),
    )
    return first ? [first, ...rest] : rest
  })
  const selectedNote = createMemo(() => entries().find((note) => note.id === selected()) ?? entries()[0])
  const goalEnabled = () =>
    props.target.sessionID !== undefined && scope() !== "global" && selectedNote() !== undefined
  const scopeText = () => scopeLabel(scope())
  const nextScope = () => {
    const values = scopes()
    const index = values.indexOf(scope())
    return values[(index + 1) % values.length] ?? values[0] ?? "folder"
  }
  const nextScopeText = () => scopeLabel(nextScope())
  let scrollTimer: ReturnType<typeof setTimeout> | undefined
  let deleteTimer: ReturnType<typeof setTimeout> | undefined

  const clearPendingDelete = () => {
    if (deleteTimer !== undefined) clearTimeout(deleteTimer)
    deleteTimer = undefined
    setPendingDelete(undefined)
  }

  createEffect(() => {
    const items = entries()
    if (items.length === 0) {
      if (selected() !== undefined) setSelected(undefined)
      return
    }
    if (!items.some((note) => note.id === selected())) setSelected(items[0]?.id)
  })

  createEffect(() => {
    selected()
    query()
    clearPendingDelete()
  })

  createEffect(() => {
    const note = selectedNote()
    if (!note || !listTarget()) return
    if (scrollTimer !== undefined) clearTimeout(scrollTimer)
    scrollTimer = setTimeout(() => {
      scrollTimer = undefined
      const box = listTarget()
      if (box && !box.isDestroyed) box.scrollChildIntoView(note.id)
    }, 0)
  })

  onCleanup(() => {
    if (scrollTimer !== undefined) clearTimeout(scrollTimer)
    if (deleteTimer !== undefined) clearTimeout(deleteTimer)
  })

  onMount(() => {
    props.context.ui.dialog.set({ size: "large", centered: true })
    setTimeout(() => {
      if (focus() === "create") {
        const target = createTarget()
        if (target && !target.isDestroyed) target.focus()
        return
      }
      const target = searchTarget()
      if (target && !target.isDestroyed) target.focus()
    }, 50)
  })

  const focusInput = (next: Focus) => {
    setFocus(next)
    const target = next === "search" ? searchTarget() : createTarget()
    if (target && !target.isDestroyed) target.focus()
  }
  const focusSearch = () => focusInput("search")
  const focusCreate = () => focusInput("create")

  const notifyError = (error: unknown) => {
    void props.context.ui.toast.show({ message: message(error), variant: "error" })
  }

  const copy = (note: Note | undefined) => {
    if (!note) return
    if (!props.context.renderer.copyToClipboardOSC52(note.text)) {
      void props.context.ui.toast.show({ message: "Could not copy note", variant: "error" })
      return
    }
    void props.context.ui.toast.show({ message: "Copied note", variant: "success" })
  }

  const cycleScope = () => {
    const values = scopes()
    const index = values.indexOf(scope())
    setScope(values[(index + 1) % values.length] ?? values[0] ?? "folder")
    clearPendingDelete()
  }

  const createNote = async () => {
    const input = createTarget()
    const text = input?.plainText.trim() ?? ""
    if (!text) {
      void props.context.ui.toast.show({ message: "Note cannot be empty", variant: "warning" })
      return
    }
    try {
      const result = await props.context.client.rpc(NotepadRpc).add(
        {
          text,
          scope: scope(),
          directory: props.target.directory,
          ...(props.target.sessionID === undefined ? {} : { session: props.target.sessionID }),
        },
        { location: props.context.location },
      ) as { note: Note }
      setNotes((values) => [...values, result.note])
      input?.setText("")
      setDraft("")
      setSelected(result.note.id)
      focusCreate()
    } catch (error) {
      notifyError(error)
    }
  }

  const insertNewline = () => {
    const input = createTarget()
    if (!input) return
    input.newLine()
    setDraft(input.plainText)
  }

  const toggleGoal = async () => {
    clearPendingDelete()
    const note = selectedNote()
    if (!note || props.target.sessionID === undefined || scope() === "global") return
    if (goal()?.noteID === note.id) {
      try {
        await props.context.client.rpc(NotepadRpc).clearGoal(
          { sessionID: props.target.sessionID },
          { location: props.context.location },
        )
        setGoal(undefined)
        void props.context.ui.toast.show({ message: "Goal cleared", variant: "success" })
      } catch (error) {
        notifyError(error)
      }
      return
    }
    try {
      const result = await props.context.client.rpc(NotepadRpc).setGoal(
        { sessionID: props.target.sessionID, noteID: note.id, directory: props.target.directory },
        { location: props.context.location },
      ) as { goal: Goal }
      setGoal(result.goal)
      void props.context.ui.toast.show({ message: "Goal set", variant: "success" })
    } catch (error) {
      notifyError(error)
    }
  }

  const snapshot = (): PanelState => ({
    query: query(),
    draft: draft(),
    scope: scope(),
    focus: focus(),
    selected: selectedNote()?.id,
  })

  const edit = async () => {
    const note = selectedNote()
    if (!note) return
    const state = snapshot()
    const result = await editDialog(props.context, { text: note.text })
    let goalCleared = false
    if (result) {
      try {
        const updated = await props.context.client.rpc(NotepadRpc).update(
          { id: note.id, text: result.text },
          { location: props.context.location },
        ) as { note: Note; goalCleared?: boolean }
        goalCleared = updated.goalCleared === true
      } catch (error) {
        notifyError(error)
      }
    }
    if (goalCleared) {
      setGoal(undefined)
      const tooLarge = result !== undefined && new TextEncoder().encode(result.text).byteLength > MAX_GOAL_BYTES
      void props.context.ui.toast.show({
        message: tooLarge ? "Goal cleared: note exceeds 8 KiB" : "Goal cleared",
        variant: "warning",
      })
    }
    await openList(props.context, props.target, { ...state, selected: note.id })
  }

  const remove = async () => {
    const note = selectedNote()
    if (!note) return
    if (goal()?.noteID === note.id) {
      clearPendingDelete()
      void props.context.ui.toast.show({
        message: "Goal note cannot be deleted. Press ctrl+t to clear the goal first.",
        variant: "warning",
      })
      return
    }
    if (pendingDelete() !== note.id) {
      clearPendingDelete()
      setPendingDelete(note.id)
      deleteTimer = setTimeout(() => {
        deleteTimer = undefined
        setPendingDelete(undefined)
      }, 3_000)
      return
    }
    clearPendingDelete()
    try {
      await props.context.client.rpc(NotepadRpc).remove({ id: note.id }, { location: props.context.location })
      deletedNotes.set(undoKey, note)
      setNotes((values) => values.filter((item) => item.id !== note.id))
      setSelected(undefined)
    } catch (error) {
      notifyError(error)
    }
  }

  const undoDelete = async () => {
    const note = deletedNotes.get(undoKey)
    if (!note) return
    deletedNotes.delete(undoKey)
    try {
      const restored = await props.context.client.rpc(NotepadRpc).add(
        {
          text: note.text,
          scope: note.scope,
          directory: note.folder ?? props.target.directory,
          ...(note.session === undefined ? {} : { session: note.session }),
          pinned: note.pinned === true,
        },
        { location: props.context.location },
      ) as { note: Note }
      setNotes((values) => [...values, restored.note])
      if (scopes().includes(restored.note.scope)) setScope(restored.note.scope)
      setSelected(restored.note.id)
      void props.context.ui.toast.show({ message: "Note restored", variant: "success" })
    } catch (error) {
      deletedNotes.set(undoKey, note)
      notifyError(error)
    }
  }

  const togglePin = async () => {
    const note = selectedNote()
    if (!note) return
    const pinned = note.pinned !== true
    try {
      const result = await props.context.client.rpc(NotepadRpc).setPinned(
        { id: note.id, pinned },
        { location: props.context.location },
      ) as { note: Note }
      setNotes((values) => values.map((item) => item.id === note.id ? result.note : item))
      void props.context.ui.toast.show({
        message: pinned ? "Note pinned" : "Note unpinned",
        variant: "success",
      })
    } catch (error) {
      notifyError(error)
    }
  }

  const cycleSort = () => {
    const next: NoteSort = sort() === "updated" ? "created" : "updated"
    setSort(next)
    void Promise.resolve(updateStored((draft) => {
      draft.sort = next
    })).catch(() => {})
  }

  // The panel has text inputs, so actions are Ctrl combos that work in either focus.
  props.context.keymap.layer(() => ({
    mode: "modal",
    priority: 20,
    commands: [
      { bind: "ctrl+e", title: "Edit note", run: () => void edit() },
      { bind: "ctrl+d", title: "Delete note", run: () => void remove() },
      { bind: "ctrl+z", title: "Undo delete", run: () => void undoDelete(), enabled: () => deletedNotes.has(undoKey) },
      { bind: "ctrl+y", title: "Copy note", run: () => copy(selectedNote()) },
      { bind: "ctrl+p", title: "Toggle note pin", run: () => void togglePin() },
      { bind: "ctrl+s", title: "Change note sort", run: cycleSort },
      { bind: "ctrl+a", title: "Switch note scope", run: cycleScope },
      { bind: "ctrl+t", title: "Toggle note goal", enabled: goalEnabled, run: () => void toggleGoal() },
      { bind: "f1", title: "Toggle notepad help", run: () => setHelp((value) => !value) },
      { bind: "escape", title: "Close notepad", run: () => {
        if (help()) setHelp(false)
        else props.context.ui.dialog.clear()
      } },
    ],
  }))

  props.context.keymap.layer(() => ({
    mode: "modal",
    target: searchTarget,
    priority: 20,
    commands: [
      { bind: "up", title: "Previous note", run: () => moveSelection(entries(), selected(), setSelected, -1) },
      { bind: "down", title: "Next note", run: () => moveSelection(entries(), selected(), setSelected, 1) },
      { bind: "tab", title: "Focus new note", run: focusCreate },
      { bind: "shift+tab", title: "Focus new note", run: focusCreate },
    ],
  }))

  props.context.keymap.layer(() => ({
    mode: "modal",
    target: createTarget,
    priority: 20,
    commands: [
      { bind: "up", title: "Previous note", run: () => moveSelection(entries(), selected(), setSelected, -1) },
      { bind: "down", title: "Next note", run: () => moveSelection(entries(), selected(), setSelected, 1) },
      { bind: "return", title: "Create note", run: () => void createNote() },
      { bind: "shift+return", title: "Insert new line", run: insertNewline },
      { bind: "tab", title: "Focus search", run: focusSearch },
      { bind: "shift+tab", title: "Focus search", run: focusSearch },
    ],
  }))

  return (
    <box paddingLeft={2} paddingRight={2} gap={1}>
      <box flexDirection="column" gap={0}>
        <box flexDirection="row" justifyContent="space-between">
          <box flexDirection="row" gap={1}>
            <text attributes={TextAttributes.BOLD} fg={theme.text.base}>Notepad</text>
            <text fg={theme.text.muted}>{scopeText()}</text>
          </box>
          <text fg={theme.text.muted}>f1 help · esc close</text>
        </box>
        <box flexDirection="row" gap={1}>
          <text fg={theme.text.muted}>ctrl+a</text>
          <text fg={theme.text.muted}>Show notes in</text>
          <text fg={accent} attributes={TextAttributes.BOLD}>{nextScopeText()}</text>
        </box>
      </box>
      <text fg={theme.text.muted}>{props.context.ui.format.path(props.target.directory)}</text>
      <Show when={help()}>
        <box flexDirection="column" paddingLeft={1} paddingRight={1} backgroundColor={theme.background.raised.high}>
          <text fg={theme.text.base} attributes={TextAttributes.BOLD}>Keyboard help</text>
          <text fg={theme.text.muted}>ctrl+a shows the next scope · tab switches search and create</text>
          <text fg={theme.text.muted}>enter creates from the create box · shift+enter adds a line</text>
          <text fg={theme.text.muted}>ctrl+t set or clear goal · ctrl+e edit · ctrl+p pin</text>
          <text fg={theme.text.muted}>ctrl+d delete (goal note protected) · ctrl+y copy · ctrl+s sort</text>
          <text fg={theme.text.muted}>↑/↓ select · f1 help · esc close</text>
        </box>
      </Show>
      <box border={["bottom"]} borderColor={focus() === "search" ? accent : borderMuted}>
        <input
          ref={(value: InputRenderable) => setSearchTarget(value)}
          value={props.state.query ?? ""}
          onInput={setQuery}
          placeholder={`Search in ${scopeText()}`}
          placeholderColor={theme.text.muted}
          backgroundColor={formBackground}
          focusedBackgroundColor={formFocusedBackground}
          textColor={theme.text.formfield.base}
          focusedTextColor={formFocusedText}
          cursorColor={theme.text.formfield.base}
        />
      </box>
      <box border={["bottom"]} borderColor={focus() === "create" ? accent : borderMuted}>
        <textarea
          ref={(value: TextareaRenderable) => setCreateTarget(value)}
          initialValue={props.state.draft ?? ""}
          height={3}
          wrapMode="word"
          onContentChange={() => {
            const input = createTarget()
            if (input && !input.isDestroyed) setDraft(input.plainText)
          }}
          placeholder={`New note in ${scopeText()}`}
          placeholderColor={theme.text.muted}
          backgroundColor={formBackground}
          focusedBackgroundColor={formFocusedBackground}
          textColor={theme.text.formfield.base}
          focusedTextColor={formFocusedText}
          cursorColor={theme.text.formfield.base}
        />
      </box>
      <scrollbox ref={(value: ScrollBoxRenderable) => setListTarget(value)} maxHeight={18}>
        <Show
          when={entries().length > 0}
          fallback={
            <text fg={theme.text.muted}>
              {query().trim() ? `No notes match in ${scopeText()}` : `No notes in ${scopeText()} yet`}
            </text>
          }
        >
          <For each={entries()}>
            {(note) => (
              <NoteRow
                note={note}
                selected={note.id === selectedNote()?.id}
                pending={note.id === pendingDelete()}
                goal={note.id === goal()?.noteID}
                theme={theme}
              />
            )}
          </For>
        </Show>
      </scrollbox>
      <text fg={theme.text.muted} wrapMode="word">
        {`ctrl+e edit · ctrl+d ${pendingDelete() ? "again to delete" : "delete"} · ctrl+p pin · `}
        <span style={{ fg: goalEnabled() ? theme.text.muted : disabled }}>ctrl+t goal</span>
        {` · ctrl+s sort: ${sort()} · ctrl+y copy${deletedNotes.has(undoKey) ? " · ctrl+z undo" : ""} · ↑/↓ select · tab search/create · f1 help`}
      </text>
    </box>
  )
}

function NoteRow(props: { note: Note; selected: boolean; pending: boolean; goal: boolean; theme: any }) {
  const first = () => props.note.text.replace(/\s+/g, " ").slice(0, 140)
  const marker = () => `${props.goal ? "🎯 " : ""}${props.note.pinned === true ? "📌 " : ""}`
  return (
    <box id={props.note.id} flexDirection="column" paddingLeft={1} paddingRight={1} backgroundColor={props.selected ? props.theme.background.raised.high : undefined}>
      <text fg={props.selected ? props.theme.text.base : props.theme.text.muted} wrapMode="word">
        {`${marker()}${first()}`}
      </text>
      <text fg={props.pending ? (props.theme.text.feedback?.warning?.base ?? props.theme.text.base) : props.theme.text.muted}>
        {props.pending
          ? "Press ctrl+d again to delete."
          : `${props.goal ? "goal · " : ""}${props.note.pinned === true ? "pinned · " : ""}${scopeShort(props.note.scope)} · ${age(props.note.updatedAt)}`}
      </text>
    </box>
  )
}

function moveSelection(entries: readonly Note[], selected: string | undefined, setSelected: (id: string | undefined) => void, delta: number) {
  if (entries.length === 0) return
  const index = Math.max(0, entries.findIndex((note) => note.id === selected))
  setSelected(entries[Math.min(entries.length - 1, Math.max(0, index + delta))]?.id)
}

type EditorInput = { text: string }
type EditorResult = { text: string }

function editDialog(context: Context, initial: EditorInput) {
  return new Promise<EditorResult | undefined>((resolve) => {
    let settled = false
    const done = (value: EditorResult | undefined) => {
      if (settled) return
      settled = true
      context.ui.dialog.clear()
      resolve(value)
    }
    context.ui.dialog.show(() => <NotepadEditor context={context} initial={initial} onDone={done} />)
  })
}

function NotepadEditor(props: { context: Context; initial: EditorInput; onDone: (value: EditorResult | undefined) => void }) {
  const [textareaTarget, setTextareaTarget] = createSignal<TextareaRenderable>()
  const theme = props.context.theme.surface("dialog")
  const formBackground = theme.background?.formfield?.base ?? theme.background?.base
  const formFocusedBackground = theme.background?.formfield?.focused ?? theme.background?.raised?.high
  const formFocusedText = theme.text?.formfield?.focused ?? theme.text.formfield.base
  let textarea: TextareaRenderable | undefined

  onMount(() => {
    props.context.ui.dialog.set({ size: "large", centered: true })
    setTimeout(() => {
      const target = textareaTarget()
      if (!target || target.isDestroyed) return
      target.focus()
      if (!target.isDestroyed) target.gotoLineEnd()
    }, 50)
  })

  const save = () => {
    const text = textarea?.plainText.trim() ?? ""
    if (!text) {
      void props.context.ui.toast.show({ message: "Note cannot be empty", variant: "error" })
      return
    }
    props.onDone({ text })
  }

  props.context.keymap.layer(() => ({
    mode: "modal",
    target: textareaTarget,
    priority: 20,
    commands: [
      { bind: "f2", title: "Save note", run: save },
      { bind: "ctrl+s", title: "Save note", run: save },
      { bind: "escape", title: "Cancel note", run: () => props.onDone(undefined) },
    ],
  }))

  return (
    <box paddingLeft={2} paddingRight={2} gap={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text attributes={TextAttributes.BOLD} fg={theme.text.base}>Edit note</text>
        <text fg={theme.text.muted}>f2 / ctrl+s save · esc cancel</text>
      </box>
      <textarea
        ref={(value: TextareaRenderable) => { textarea = value; setTextareaTarget(value) }}
        initialValue={props.initial.text}
        height={8}
        wrapMode="word"
        placeholder="Write a note…"
        placeholderColor={theme.text.muted}
        backgroundColor={formBackground}
        focusedBackgroundColor={formFocusedBackground}
        textColor={theme.text.formfield.base}
        focusedTextColor={formFocusedText}
        cursorColor={theme.text.base}
      />
      <text fg={theme.text.muted}>f2 / ctrl+s save · esc cancel</text>
    </box>
  )
}

function age(timestamp: number) {
  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000))
  if (seconds < 60) return "just now"
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days}d ago`
  return new Date(timestamp).toLocaleDateString()
}

function message(error: unknown) {
  return error instanceof Error ? error.message : "Unable to update notes"
}
