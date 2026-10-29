import { Plugin } from "@opencode/plugin/tui"
import type { Context } from "@opencode/plugin/tui/context"
import { TextAttributes, type InputRenderable, type ScrollBoxRenderable, type TextareaRenderable } from "@opentui/core"
import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js"
import { NotepadRpc } from "./rpc.js"
import type { Note, NoteScope } from "./types.js"

export const DEFAULT_KEYBIND = "ctrl+shift+n"
export const COMMAND_ID = "max10240.notepad.open"

type NoteResult = { notes: Note[] }

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
      description: "Capture and manage notes for this folder or globally",
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

async function openNotepad(context: Context) {
  const directory = await currentDirectory(context)
  if (!directory) {
    void context.ui.toast.show({ message: "Open a project folder first", variant: "warning" })
    return
  }
  await openList(context, directory)
}

async function currentDirectory(context: Context) {
  const route = context.ui.router.current()
  if (route.type === "session") {
    try {
      const session = await context.client.session.get({ sessionID: route.sessionID })
      const directory = session?.location?.directory
      if (typeof directory === "string" && directory) return directory
    } catch {}
  }
  return context.location?.directory
}

async function fetchNotes(context: Context, directory: string) {
  const result = await context.client.rpc(NotepadRpc).list({ directory }, { location: context.location }) as NoteResult
  return result.notes
}

async function openList(context: Context, directory: string, selected?: string) {
  let notes: Note[]
  try {
    notes = await fetchNotes(context, directory)
  } catch (error) {
    await context.ui.dialog.alert({ title: "Notepad", message: message(error) })
    return
  }
  context.ui.dialog.show(() => <NotepadList context={context} directory={directory} initial={notes} selected={selected} />)
}

function NotepadList(props: { context: Context; directory: string; initial: Note[]; selected?: string }) {
  const [notes, setNotes] = createSignal(props.initial)
  const [query, setQuery] = createSignal("")
  const [selected, setSelected] = createSignal<string | undefined>(props.selected ?? props.initial[0]?.id)
  const [listTarget, setListTarget] = createSignal<ScrollBoxRenderable>()
  const [searchTarget, setSearchTarget] = createSignal<InputRenderable>()
  const theme = props.context.theme.surface("dialog")
  const folder = createMemo(() => notes().filter((note) => note.scope === "folder"))
  const global = createMemo(() => notes().filter((note) => note.scope === "global"))
  const matches = (note: Note) => {
    const value = query().trim().toLowerCase()
    return !value || note.text.toLowerCase().includes(value)
  }
  const folderMatches = createMemo(() => folder().filter(matches))
  const globalMatches = createMemo(() => global().filter(matches))
  const entries = createMemo(() => [...folderMatches(), ...globalMatches()])
  const selectedNote = createMemo(() => entries().find((note) => note.id === selected()) ?? entries()[0])
  let scrollTimer: ReturnType<typeof setTimeout> | undefined

  createEffect(() => {
    const items = entries()
    if (items.length === 0) {
      if (selected() !== undefined) setSelected(undefined)
      return
    }
    if (!items.some((note) => note.id === selected())) setSelected(items[0]?.id)
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
  })

  onMount(() => {
    props.context.ui.dialog.set({ size: "large", centered: true })
    setTimeout(() => listTarget()?.focus(), 50)
  })

  const focusSearch = () => {
    setSearchTargetFocus(searchTarget, true)
  }
  const focusList = () => {
    setSearchTargetFocus(searchTarget, false)
    listTarget()?.focus()
  }

  const copy = (note: Note | undefined) => {
    if (!note) return
    if (!props.context.renderer.copyToClipboardOSC52(note.text)) {
      void props.context.ui.toast.show({ message: "Could not copy note", variant: "error" })
      return
    }
    void props.context.ui.toast.show({ message: "Copied note", variant: "success" })
  }

  const reload = async (select?: string) => {
    try {
      const next = await fetchNotes(props.context, props.directory)
      setNotes(next)
      if (select && next.some((note) => note.id === select)) setSelected(select)
    } catch (error) {
      await props.context.ui.dialog.alert({ title: "Notepad", message: message(error) })
    }
  }

  const add = async () => {
    const result = await editDialog(props.context, { scope: "folder" })
    if (!result) {
      await openList(props.context, props.directory, selected())
      return
    }
    try {
      const note = await props.context.client.rpc(NotepadRpc).add(
        { text: result.text, scope: result.scope, directory: props.directory },
        { location: props.context.location },
      ) as { note: Note }
      await openList(props.context, props.directory, note.note.id)
    } catch (error) {
      await props.context.ui.dialog.alert({ title: "Notepad", message: message(error) })
      await openList(props.context, props.directory, selected())
    }
  }

  const edit = async () => {
    const note = selectedNote()
    if (!note) return
    const result = await editDialog(props.context, { text: note.text, scope: note.scope })
    if (!result) {
      await openList(props.context, props.directory, note.id)
      return
    }
    try {
      await props.context.client.rpc(NotepadRpc).update({ id: note.id, text: result.text }, { location: props.context.location })
      if (result.scope !== note.scope) {
        await props.context.client.rpc(NotepadRpc).setScope(
          { id: note.id, scope: result.scope, directory: props.directory },
          { location: props.context.location },
        )
      }
      await openList(props.context, props.directory, note.id)
    } catch (error) {
      await props.context.ui.dialog.alert({ title: "Notepad", message: message(error) })
      await openList(props.context, props.directory, note.id)
    }
  }

  const remove = async () => {
    const note = selectedNote()
    if (!note) return
    const confirmed = await props.context.ui.dialog.confirm({
      title: "Delete note?",
      message: `${note.text.replace(/\s+/g, " ").slice(0, 120)}${note.text.length > 120 ? "…" : ""}`,
      label: { confirm: "Delete", cancel: "Cancel" },
    })
    if (!confirmed) {
      await openList(props.context, props.directory, note.id)
      return
    }
    try {
      await props.context.client.rpc(NotepadRpc).remove({ id: note.id }, { location: props.context.location })
    } catch (error) {
      await props.context.ui.dialog.alert({ title: "Notepad", message: message(error) })
      await openList(props.context, props.directory, note.id)
      return
    }
    await openList(props.context, props.directory)
  }

  const toggleScope = async () => {
    const note = selectedNote()
    if (!note) return
    const scope: NoteScope = note.scope === "folder" ? "global" : "folder"
    try {
      await props.context.client.rpc(NotepadRpc).setScope(
        { id: note.id, scope, directory: props.directory },
        { location: props.context.location },
      )
      await reload(note.id)
      void props.context.ui.toast.show({
        message: scope === "global" ? "Moved to Global" : "Moved to This folder",
        variant: "success",
      })
    } catch (error) {
      await props.context.ui.dialog.alert({ title: "Notepad", message: message(error) })
    }
  }

  props.context.keymap.layer(() => ({
    mode: "modal",
    target: listTarget,
    priority: 20,
    commands: [
      { bind: "up", title: "Previous note", run: () => moveSelection(entries(), selected(), setSelected, -1) },
      { bind: "down", title: "Next note", run: () => moveSelection(entries(), selected(), setSelected, 1) },
      { bind: "a", title: "Add note", run: () => void add() },
      { bind: "e", title: "Edit note", run: () => void edit() },
      { bind: "d", title: "Delete note", run: () => void remove() },
      { bind: "c", title: "Copy note", run: () => copy(selectedNote()) },
      { bind: "g", title: "Toggle note scope", run: () => void toggleScope() },
      { bind: "/", title: "Search notes", run: focusSearch },
      { bind: "tab", title: "Search notes", run: focusSearch },
      { bind: "escape", title: "Close notepad", run: () => props.context.ui.dialog.clear() },
    ],
  }))

  props.context.keymap.layer(() => ({
    mode: "modal",
    target: searchTarget,
    priority: 20,
    commands: [
      { bind: "escape", title: "Back to notes", run: focusList },
      { bind: "tab", title: "Back to notes", run: focusList },
      { bind: "return", title: "Back to notes", run: focusList },
    ],
  }))

  return (
    <box paddingLeft={2} paddingRight={2} gap={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text attributes={TextAttributes.BOLD} fg={theme.text.base}>Notepad</text>
        <text fg={theme.text.muted}>esc close</text>
      </box>
      <text fg={theme.text.muted}>{props.context.ui.format.path(props.directory)}</text>
      <input
        ref={(value: InputRenderable) => setSearchTarget(value)}
        onInput={setQuery}
        onSubmit={focusList}
        placeholder={query() ? "" : "Press / or Tab to search"}
        placeholderColor={theme.text.muted}
        textColor={theme.text.formfield.base}
        focusedTextColor={theme.text.formfield.base}
        cursorColor={theme.text.formfield.base}
      />
      <scrollbox ref={(value: ScrollBoxRenderable) => setListTarget(value)} focusable maxHeight={18}>
        <Show when={entries().length > 0} fallback={<text fg={theme.text.muted}>No notes yet. Press a to add one.</text>}>
          <Show when={folderMatches().length > 0}>
            <text fg={theme.text.muted}>This folder</text>
            <For each={folderMatches()}>
              {(note) => <NoteRow note={note} selected={note.id === selectedNote()?.id} theme={theme} />}
            </For>
          </Show>
          <Show when={globalMatches().length > 0}>
            <text fg={theme.text.muted}>Global</text>
            <For each={globalMatches()}>
              {(note) => <NoteRow note={note} selected={note.id === selectedNote()?.id} theme={theme} />}
            </For>
          </Show>
        </Show>
      </scrollbox>
      <text fg={theme.text.muted}>a add · e edit · d delete · c copy · g scope · / search · tab switch · esc close</text>
    </box>
  )
}

function NoteRow(props: { note: Note; selected: boolean; theme: any }) {
  const first = () => props.note.text.replace(/\s+/g, " ").slice(0, 140)
  return (
    <box id={props.note.id} flexDirection="column" paddingLeft={1} paddingRight={1} backgroundColor={props.selected ? props.theme.background.raised.high : undefined}>
      <text fg={props.selected ? props.theme.text.base : props.theme.text.muted} wrapMode="word">{first()}</text>
      <text fg={props.theme.text.muted}>{`${props.note.scope === "global" ? "global" : "folder"} · ${age(props.note.updatedAt)}`}</text>
    </box>
  )
}

function moveSelection(entries: readonly Note[], selected: string | undefined, setSelected: (id: string | undefined) => void, delta: number) {
  if (entries.length === 0) return
  const index = Math.max(0, entries.findIndex((note) => note.id === selected))
  setSelected(entries[Math.min(entries.length - 1, Math.max(0, index + delta))]?.id)
}

function setSearchTargetFocus(target: () => InputRenderable | undefined, focus: boolean) {
  const input = target()
  if (!input) return
  if (focus) input.focus()
}

type EditorInput = { text?: string; scope: NoteScope }
type EditorResult = { text: string; scope: NoteScope }

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
  const [scope, setScope] = createSignal<NoteScope>(props.initial.scope)
  const [textareaTarget, setTextareaTarget] = createSignal<TextareaRenderable>()
  const theme = props.context.theme.surface("dialog")
  let textarea: TextareaRenderable | undefined

  onMount(() => {
    props.context.ui.dialog.set({ size: "large", centered: true })
    setTimeout(() => {
      const target = textareaTarget()
      if (!target) return
      target.focus()
      target.gotoLineEnd()
    }, 50)
  })

  const save = () => {
    const text = textarea?.plainText.trim() ?? ""
    if (!text) {
      void props.context.ui.toast.show({ message: "Note cannot be empty", variant: "error" })
      return
    }
    props.onDone({ text, scope: scope() })
  }

  props.context.keymap.layer(() => ({
    mode: "modal",
    target: textareaTarget,
    priority: 20,
    commands: [
      { bind: "f2", title: "Save note", run: save },
      { bind: "ctrl+return", title: "Save note", run: save },
      { bind: "ctrl+g", title: "Toggle note scope", run: () => setScope((value) => value === "folder" ? "global" : "folder") },
      { bind: "escape", title: "Cancel note", run: () => props.onDone(undefined) },
    ],
  }))

  return (
    <box paddingLeft={2} paddingRight={2} gap={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text attributes={TextAttributes.BOLD} fg={theme.text.base}>{props.initial.text === undefined ? "New note" : "Edit note"}</text>
        <text fg={theme.text.muted}>esc cancel</text>
      </box>
      <textarea
        ref={(value: TextareaRenderable) => { textarea = value; setTextareaTarget(value) }}
        initialValue={props.initial.text ?? ""}
        height={8}
        wrapMode="word"
        placeholder="Write a note…"
        placeholderColor={theme.text.muted}
        textColor={theme.text.formfield.base}
        focusedTextColor={theme.text.formfield.base}
        cursorColor={theme.text.base}
      />
      <text fg={theme.text.muted}>f2 / ctrl+enter save · esc cancel · ctrl+g target: {scope() === "global" ? "Global" : "This folder"}</text>
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
