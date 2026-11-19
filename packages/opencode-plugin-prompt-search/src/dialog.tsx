import { TextAttributes, type EditBufferRenderable, type InputRenderable, type ScrollBoxRenderable } from "@opentui/core"
import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js"
import type { Context } from "@opencode/plugin/tui/context"
import { PromptIndexer, type PromptEntry } from "./indexer.js"
import { matchText, type ParsedQuery } from "./query.js"
import {
  DialogFrame,
  EmptyState,
  FooterHints,
  HelpPanel,
  HighlightText,
  NoticeLine,
  ResultList,
  SearchField,
  formatRelative,
} from "./ui.js"

const PREVIEW_CHARS = 600

export function PromptSearchDialog(props: {
  context: Context
  indexer: PromptIndexer
  composer?: EditBufferRenderable | null
}) {
  const dialog = props.context.ui.dialog
  const theme = props.context.theme.surface("dialog")
  const defaultScope = props.context.options.defaultScope === "project" ? "project" : "all"
  const storage = (() => {
    try {
      return props.context.storage.store<{ scope: "all" | "project" }>("prompt-search.preferences", {
        initial: { scope: defaultScope },
      })
    } catch {
      return undefined
    }
  })()
  const [stored, updateStored] = storage ?? [{ scope: defaultScope }, () => {}]
  const [query, setQuery] = createSignal("")
  const [selected, setSelected] = createSignal(0)
  const [scope, setScope] = createSignal<"all" | "project">(stored.scope === "all" || stored.scope === "project" ? stored.scope : defaultScope)
  const [projectID, setProjectID] = createSignal<string>()
  const [inputTarget, setInputTarget] = createSignal<InputRenderable>()
  const [resultsTarget, setResultsTarget] = createSignal<ScrollBoxRenderable>()
  const [help, setHelp] = createSignal(false)
  const [notice, setNotice] = createSignal<string>()
  const [now, setNow] = createSignal(Date.now())
  const page = createMemo(() => props.indexer.searchPage(query(), 100, { projectID: projectID(), scope: scope() }))
  const results = createMemo(() => page().entries)
  const selectedEntry = createMemo(() => results()[selected()])
  let scrollTimer: ReturnType<typeof setTimeout> | undefined
  let clock: ReturnType<typeof setInterval> | undefined
  let noticeTimer: ReturnType<typeof setTimeout> | undefined
  let disposed = false

  createEffect(() => {
    results()
    setSelected(0)
  })

  createEffect(() => {
    const entries = results()
    const index = selected()
    if (!entries[index] || !resultsTarget()) return
    if (scrollTimer !== undefined) clearTimeout(scrollTimer)
    scrollTimer = setTimeout(() => {
      scrollTimer = undefined
      const scrollbox = resultsTarget()
      if (!scrollbox || scrollbox.isDestroyed) return
      scrollbox.scrollChildIntoView(resultID(index))
    }, 0)
  })

  const showNotice = (message: string) => {
    if (noticeTimer !== undefined) clearTimeout(noticeTimer)
    setNotice(message)
    noticeTimer = setTimeout(() => {
      noticeTimer = undefined
      setNotice(undefined)
    }, 2500)
  }

  onCleanup(() => {
    disposed = true
    if (scrollTimer !== undefined) clearTimeout(scrollTimer)
    if (clock !== undefined) clearInterval(clock)
    if (noticeTimer !== undefined) clearTimeout(noticeTimer)
  })

  const toggleScope = () => {
    if (scope() === "all" && !projectID()) {
      void props.context.ui.toast.show({ message: "Current project is not available", variant: "warning" })
      return
    }
    const next = scope() === "all" ? "project" : "all"
    setScope(next)
    void Promise.resolve(updateStored((draft) => {
      draft.scope = next
    })).catch(() => {})
    showNotice(next === "all" ? "Scope: all projects" : "Scope: current project")
  }

  const select = async (entry: PromptEntry | undefined) => {
    if (!entry) return
    const route = props.context.ui.router.current()
    if (route.type !== "session") {
      dialog.clear()
      props.context.ui.toast.show({ message: "Open a session first", variant: "warning" })
      return
    }
    dialog.clear()
    try {
      const composer = props.composer ?? props.context.renderer.currentFocusedEditor
      if (!composer) throw new Error("Could not find the current prompt input")
      composer.insertText(entry.text)
      composer.focus()
      props.context.ui.toast.show({ message: "Previous prompt inserted", variant: "success" })
    } catch (error) {
      props.context.ui.toast.show({
        message: error instanceof Error ? error.message : String(error),
        variant: "error",
      })
    }
  }

  const copy = () => {
    const entry = selectedEntry()
    if (!entry) {
      showNotice("Select a prompt to copy")
      return
    }
    if (!props.context.renderer.copyToClipboardOSC52(entry.text)) {
      showNotice("Could not copy prompt")
      return
    }
    showNotice(`Copied prompt · ${entry.text.length} chars`)
  }

  const move = (delta: number) => {
    const count = results().length
    if (count === 0) return
    setSelected((value) => Math.max(0, Math.min(count - 1, value + delta)))
  }

  const focusResults = () => resultsTarget()?.focus()
  const focusInput = () => inputTarget()?.focus()
  const commands = (questionMark: boolean) => [
    { bind: "f1", title: "Toggle prompt help", run: () => setHelp((value) => !value) },
    ...(questionMark ? [{ bind: "?", title: "Toggle prompt help", run: () => setHelp((value) => !value) }] : []),
    ...(!questionMark && help() ? [{ bind: "?", title: "Toggle prompt help", run: () => setHelp(false) }] : []),
    { bind: "ctrl+p", title: "Toggle prompt scope", run: toggleScope },
    { bind: "ctrl+y", title: "Copy prompt", run: copy },
    ...(help()
      ? [{ bind: "escape", title: "Close prompt help", run: () => setHelp(false) }]
      : [{ bind: "escape", title: "Close prompt search", run: () => dialog.clear() }]),
  ]

  props.context.keymap.layer(() => ({
    mode: "modal",
    target: inputTarget,
    priority: 20,
    commands: [
      ...commands(false),
      { bind: "up", title: "Previous prompt", run: () => move(-1) },
      { bind: "down", title: "Next prompt", run: () => move(1) },
      { bind: "tab", title: "Focus prompt results", run: focusResults },
      { bind: "return", title: "Use prompt", run: () => void select(selectedEntry()) },
    ],
  }))
  props.context.keymap.layer(() => ({
    mode: "modal",
    target: resultsTarget,
    priority: 20,
    commands: [
      ...commands(true),
      { bind: "up", title: "Previous prompt", run: () => move(-1) },
      { bind: "down", title: "Next prompt", run: () => move(1) },
      { bind: "k", title: "Previous prompt", run: () => move(-1) },
      { bind: "j", title: "Next prompt", run: () => move(1) },
      { bind: "tab", title: "Focus prompt search", run: focusInput },
      { bind: "return", title: "Use prompt", run: () => void select(selectedEntry()) },
    ],
  }))

  onMount(() => {
    dialog.set({ size: "large", centered: true })
    setTimeout(() => inputTarget()?.focus(), 1)
    clock = setInterval(() => setNow(Date.now()), 30_000)
    const route = props.context.ui.router.current()
    if (route.type === "session") {
      const current = props.context.data.session.get(route.sessionID)
      if (current?.projectID) setProjectID(current.projectID)
      else void props.context.client.session.get({ sessionID: route.sessionID }).then((info) => {
        if (!disposed && info.projectID) setProjectID(info.projectID)
      }).catch(() => {})
    }
    void props.indexer.refresh()
  })

  const scopeLabel = () => scope() === "all" ? "all projects" : "current project"
  const scopeHint = () => scope() === "all" ? "current project" : "all projects"
  const countLabel = () => page().total === results().length
    ? `${results().length} matches`
    : `${results().length}/${page().total} matches`
  const emptyMessage = () => {
    const parsed = page().query
    if (parsed.tokens.length > 0) return "No matching prompts. Use fewer words, quotes for a phrase, or -term to exclude."
    return "No prompts indexed yet."
  }
  const preview = () => {
    const entry = selectedEntry()
    if (!entry) return ""
    const value = entry.text.replaceAll("\n", " ")
    return value.length > PREVIEW_CHARS ? `${value.slice(0, PREVIEW_CHARS)}…` : value
  }

  return (
    <DialogFrame
      theme={theme}
      title="Search previous prompts"
      meta={`${scopeLabel()} · ${countLabel()} · ?/f1 help · esc close`}
      footer={
        <FooterHints theme={theme}>
          {`ctrl+p ${scopeHint()} · ctrl+y copy · ↑/↓ select · enter use · tab focus · ?/f1 help`}
        </FooterHints>
      }
    >
      <SearchField
        theme={theme}
        inputRef={(value) => setInputTarget(value)}
        onInput={(value) => {
          setQuery(value)
          setNotice(undefined)
        }}
        onSubmit={() => void select(selectedEntry())}
        placeholder='Search prompts... AND · "exact phrase" · -exclude'
      />
      <Show when={help()}>
        <HelpPanel
          theme={theme}
          lines={[
            "Type words to require all of them.",
            'Use "quoted words" for an exact phrase.',
            "Prefix a word with - to exclude it.",
            "Ctrl+P switches all projects and the current project.",
            "Ctrl+Y copies the selected prompt.",
            "Tab moves focus between search and results.",
          ]}
        />
      </Show>
      <Show when={notice()}>
        {(message) => <NoticeLine theme={theme} message={message()} variant="info" />}
      </Show>
      <ResultList
        theme={theme}
        listRef={(value) => setResultsTarget(value)}
        when={results().length > 0}
        empty={emptyMessage()}
      >
        <For each={results()}>
          {(entry, index) => (
            <PromptRow
              entry={entry}
              index={index()}
              selected={index() === selected()}
              query={page().query}
              now={now()}
              theme={theme}
            />
          )}
        </For>
      </ResultList>
      <Show when={selectedEntry()} fallback={<EmptyState theme={theme} message="Select a prompt to preview it." />}>
        <box flexDirection="column" paddingLeft={1} paddingRight={1} gap={0} backgroundColor={theme.background.raised.high}>
          <text fg={theme.text.muted} attributes={TextAttributes.BOLD}>Preview</text>
          <HighlightText theme={theme} text={preview()} ranges={matchText(preview(), page().query) ?? []} />
        </box>
      </Show>
    </DialogFrame>
  )
}

function PromptRow(props: {
  entry: PromptEntry
  index: number
  selected: boolean
  query: ParsedQuery
  now: number
  theme: any
}) {
  const text = () => {
    const value = props.entry.text.replaceAll("\n", " ")
    return value.length > 240 ? `${value.slice(0, 240)}…` : value
  }
  const ranges = () => matchText(text(), props.query) ?? []
  const source = () => props.entry.title ?? `${props.entry.sessionID.slice(0, 8)}…`
  const directory = () => shortDirectory(props.entry.directory)
  return (
    <box
      id={resultID(props.index)}
      flexDirection="column"
      paddingLeft={1}
      paddingRight={1}
      backgroundColor={props.selected ? props.theme.background.raised.high : undefined}
    >
      <HighlightText theme={props.theme} text={text()} ranges={ranges()} muted={!props.selected} />
      <text fg={props.theme.text.muted} wrapMode="none" truncate>
        {`${props.index + 1}. prompt · ${source()} · ${formatRelative(props.entry.created, props.now)}${directory() ? ` · ${directory()}` : ""}`}
      </text>
    </box>
  )
}

function shortDirectory(value: string | undefined) {
  if (!value) return ""
  const parts = value.split(/[\\/]/).filter(Boolean)
  return parts.slice(-2).join("/")
}

function resultID(index: number) {
  return `prompt-search-result-${index}`
}
