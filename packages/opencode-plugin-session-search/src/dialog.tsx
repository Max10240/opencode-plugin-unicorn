import type { InputRenderable, ScrollBoxRenderable } from "@opentui/core"
import { createEffect, createSignal, For, onCleanup, onMount, Show } from "solid-js"
import type { Context } from "@opencode/plugin/tui/context"
import type { SessionSearchController } from "./controller.js"
import type { SessionNavigator } from "./navigation.js"
import { queuedMessage, type Match, type SearchResult } from "./search.js"
import { registerKeymap } from "./keymap.js"
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

// Copy feedback stays inside the dialog: a new copy restarts the timer, and changing the query or scope dismisses it.
const NOTICE_DURATION = 2_500
const USER_ROLES = ["user"] as const

export type SessionSearchDialogState = { query: string; includeAgent?: boolean; selected?: string }
export type SessionSearchNotice = { message: string; variant: "success" | "error" }
type Notice = SessionSearchNotice

export function SessionSearchDialog(props: {
  context: Context
  controller: SessionSearchController
  navigator: SessionNavigator
  sessionID: string
  revision: () => number
  lifetime: AbortController
  noticeDuration?: number
  initial?: SessionSearchDialogState
  initialNotice?: SessionSearchNotice
  onState?: (state: SessionSearchDialogState) => void
  onFailure?: (message: string) => void
}) {
  const theme = props.context.theme.surface("dialog")
  const configuredDefault = props.context.options.defaultIncludeAgent === true
  const storage = (() => {
    try {
      return props.context.storage.store<{ includeAgent: boolean }>("session-search.preferences", {
        initial: { includeAgent: configuredDefault },
      })
    } catch {
      return undefined
    }
  })()
  const [stored, updateStored] = storage ?? [{ includeAgent: configuredDefault }, () => {}]
  const [query, setQuery] = createSignal(props.initial?.query ?? "")
  const [result, setResult] = createSignal<SearchResult>({ matches: [], total: 0 })
  const [selected, setSelected] = createSignal<string | undefined>(props.initial?.selected)
  const [searching, setSearching] = createSignal(false)
  const [includeAgent, setIncludeAgent] = createSignal(
    props.initial?.includeAgent ?? (typeof stored.includeAgent === "boolean" ? stored.includeAgent : configuredDefault),
  )
  const [notice, setNotice] = createSignal<Notice | undefined>(props.initialNotice)
  const [help, setHelp] = createSignal(false)
  const [input, setInput] = createSignal<InputRenderable>()
  const [scroll, setScroll] = createSignal<ScrollBoxRenderable>()
  const [now, setNow] = createSignal(Date.now())
  let generation = 0
  let selecting = false
  let noticeTimer: ReturnType<typeof setTimeout> | undefined
  let clock: ReturnType<typeof setInterval> | undefined
  const queued = (entry: Match) => queuedMessage(entry.messageID, props.context.data.session.pending.list(props.sessionID) ?? [])
  const selectedEntry = () => result().matches.find((entry) => entry.key === selected())
  const clearNotice = () => {
    if (noticeTimer !== undefined) { clearTimeout(noticeTimer); noticeTimer = undefined }
    setNotice(undefined)
  }
  const showNotice = (message: string, variant: Notice["variant"]) => {
    if (noticeTimer !== undefined) clearTimeout(noticeTimer)
    setNotice({ message, variant })
    noticeTimer = setTimeout(() => { noticeTimer = undefined; setNotice(undefined) }, props.noticeDuration ?? NOTICE_DURATION)
  }
  createEffect(() => {
    props.onState?.({ query: query(), includeAgent: includeAgent(), selected: selected() })
  })
  const status = () => {
    props.revision()
    return props.controller.error ?? result().error ?? `${props.controller.loading || !props.controller.ready ? "Loading history · " : ""}${props.controller.index.size} text parts · ${result().matches.length}/${result().total} matches${result().total > 100 ? " · narrow your query" : ""}`
  }
  createEffect(() => {
    props.revision()
    const value = query()
    const roles = includeAgent() ? undefined : USER_ROLES
    const token = ++generation
    const request = new AbortController()
    setSearching(true)
    const timer = setTimeout(() => {
      void props.controller.index.search(value, request.signal, 100, undefined, roles).then((next) => {
        if (generation !== token || request.signal.aborted) return
        setResult(next)
        setSelected((previous) => next.matches.some((entry) => entry.key === previous) ? previous : next.matches[0]?.key)
        setSearching(false)
      }).catch((error) => {
        if (generation !== token || request.signal.aborted) return
        setResult({ matches: [], total: 0, error: error instanceof Error ? error.message : String(error) })
        setSearching(false)
      })
    }, 75)
    onCleanup(() => { clearTimeout(timer); request.abort() })
  })
  createEffect(() => {
    const key = selected()
    const entries = result().matches
    const position = entries.findIndex((entry) => entry.key === key)
    const box = scroll()
    if (position < 0 || !box) return
    const timer = setTimeout(() => { if (!box.isDestroyed) box.scrollChildIntoView(`session-search-result-${position}`) }, 0)
    onCleanup(() => clearTimeout(timer))
  })
  const choose = async (entry?: Match) => {
    if (!entry || searching() || selecting || !props.controller.ready) return
    if (props.context.ui.router.current().type !== "session" || (props.context.ui.router.current() as { sessionID?: string }).sessionID !== props.sessionID) return
    if (entry.reverted) { props.context.ui.toast.show({ message: "This message is currently reverted and cannot be shown", variant: "warning" }); return }
    if (queued(entry)) { props.context.ui.toast.show({ message: "Queued prompts are not in the transcript yet", variant: "warning" }); return }
    selecting = true
    try {
      await props.navigator.jump(props.sessionID, entry)
      props.context.ui.dialog.clear()
    } catch (error) {
      const aborted = typeof error === "object" && error !== null && "name" in error && error.name === "AbortError"
      if (!aborted) {
        const message = error instanceof Error ? error.message : String(error)
        if (props.onFailure) props.onFailure(message)
        else showNotice(message, "error")
      }
    } finally {
      selecting = false
    }
  }
  const copy = (entry?: Match) => {
    if (!entry) { showNotice("Select a message to copy", "error"); return }
    const text = props.controller.index.messageText(entry.messageID) || entry.text
    try {
      if (!props.context.renderer.copyToClipboardOSC52(text)) throw new Error("Clipboard unavailable")
      const count = text.length
      showNotice(`Copied ${entry.role === "user" ? "user" : "agent"} message · ${count} ${count === 1 ? "char" : "chars"}`, "success")
    } catch {
      showNotice("Could not copy to clipboard", "error")
    }
  }
  const toggleRoles = () => {
    clearNotice()
    const next = !includeAgent()
    setIncludeAgent(next)
    void Promise.resolve(updateStored((draft) => {
      draft.includeAgent = next
    })).catch(() => {}).catch(() => {})
  }
  const move = (delta: number) => {
    const entries = result().matches
    const at = entries.findIndex((entry) => entry.key === selected())
    setSelected(entries[Math.max(0, Math.min(entries.length - 1, at + delta))]?.key)
  }
  const focusResults = () => scroll()?.focus()
  const focusInput = () => input()?.focus()
  const commands = (questionMark: boolean) => [
    { bind: "f1", title: "Toggle session search help", run: () => setHelp((value) => !value) },
    ...(questionMark ? [{ bind: "?", title: "Toggle session search help", run: () => setHelp((value) => !value) }] : []),
    ...(!questionMark && help() ? [{ bind: "?", title: "Toggle session search help", run: () => setHelp(false) }] : []),
    { bind: "ctrl+t", title: "Toggle agent messages", run: toggleRoles },
    { bind: "ctrl+y", title: "Copy selected message", run: () => copy(selectedEntry()) },
    ...(help()
      ? [{ bind: "escape", title: "Close session search help", run: () => setHelp(false) }]
      : [{ bind: "escape", title: "Close session search", run: () => props.context.ui.dialog.clear() }]),
  ]
  registerKeymap(props.context, () => ({ mode: "modal", target: input, priority: 20, commands: [
    ...commands(false),
    { bind: "up", title: "Previous result", run: () => move(-1) },
    { bind: "down", title: "Next result", run: () => move(1) },
    { bind: "tab", title: "Focus session results", run: focusResults },
    { bind: "return", title: "Jump to message", run: () => void choose(selectedEntry()) },
  ] }))
  registerKeymap(props.context, () => ({ mode: "modal", target: scroll, priority: 20, commands: [
    ...commands(true),
    { bind: "up", title: "Previous result", run: () => move(-1) },
    { bind: "down", title: "Next result", run: () => move(1) },
    { bind: "k", title: "Previous result", run: () => move(-1) },
    { bind: "j", title: "Next result", run: () => move(1) },
    { bind: "tab", title: "Focus session search", run: focusInput },
    { bind: "return", title: "Jump to message", run: () => void choose(selectedEntry()) },
  ] }))
  onMount(() => {
    props.context.ui.dialog.set({ size: "large", centered: true })
    setTimeout(() => {
      const element = input()
      if (!element) return
      element.value = props.initial?.query ?? ""
      element.focus()
    }, 1)
    clock = setInterval(() => setNow(Date.now()), 30_000)
    void props.controller.open(props.sessionID, props.lifetime.signal)
  })
  onCleanup(() => {
    if (noticeTimer !== undefined) clearTimeout(noticeTimer)
    if (clock !== undefined) clearInterval(clock)
    props.lifetime.abort()
  })
  const roleLabel = () => includeAgent() ? "user + agent" : "user only"
  const roleHint = () => includeAgent() ? "user only" : "show agent"
  const emptyMessage = () => result().error ?? (searching() ? "Searching..." : "No matching dialogue. Use fewer words, quotes for a phrase, or -term to exclude.")
  return <DialogFrame
    theme={theme}
    title="Search current session"
    meta={`${roleLabel()} · ${result().matches.length}/${result().total} matches · ?/f1 help · esc close`}
    footer={
      <FooterHints theme={theme}>
        {`↑/↓ select · enter jump · ctrl+y copy · ctrl+t ${roleHint()} · tab focus · ?/f1 help`}
      </FooterHints>
    }
  >
    <SearchField
      theme={theme}
      inputRef={setInput}
      onInput={(value) => { clearNotice(); setSelected(undefined); setQuery(value) }}
      onSubmit={() => void choose(selectedEntry())}
      placeholder={includeAgent() ? 'Search user and agent messages... AND · "phrase" · -exclude' : 'Search user messages... AND · "phrase" · -exclude'}
    />
    <Show when={help()}>
      <HelpPanel
        theme={theme}
        lines={[
          "Type words to require all of them.",
          'Use "quoted words" for an exact phrase.',
          "Prefix a word with - to exclude it.",
          "Ctrl+T switches between user-only and user + agent.",
          "Ctrl+Y copies the whole selected message.",
          "Tab moves focus between search and results.",
        ]}
      />
    </Show>
    <Show when={notice()} keyed fallback={<text fg={theme.text.muted}>{status()}</text>}>
      {(current) => <NoticeLine theme={theme} message={current.message} variant={current.variant} />}
    </Show>
    <ResultList theme={theme} listRef={setScroll} when={result().matches.length > 0} empty={emptyMessage()}>
      <For each={result().matches}>
        {(entry, index) => <SessionRow entry={entry} index={index()} selected={entry.key === selected()} now={now()} queued={queued(entry)} theme={theme} />}
      </For>
    </ResultList>
  </DialogFrame>
}

function SessionRow(props: {
  entry: Match
  index: number
  selected: boolean
  now: number
  queued: boolean
  theme: any
}) {
  const role = () => props.entry.role === "user"
    ? "User"
    : `Agent${props.entry.agent ? ` (${props.entry.agent})` : ""}`
  const part = () => props.entry.matchKind === "message-start"
    ? "message start"
    : `part ${(props.entry.ordinal ?? 0) + 1} · exact`
  const status = () => [
    props.entry.beforeCompaction ? "before compaction" : "",
    props.entry.reverted ? "reverted, unavailable" : "",
    props.queued ? "queued, unavailable" : "",
  ].filter(Boolean).join(" · ")
  return (
    <box
      id={`session-search-result-${props.index}`}
      flexDirection="column"
      paddingLeft={1}
      paddingRight={1}
      backgroundColor={props.selected ? props.theme.background.raised.high : undefined}
    >
      <HighlightText theme={props.theme} text={props.entry.preview} ranges={props.entry.ranges} muted={!props.selected} />
      <text fg={props.theme.text.muted} wrapMode="none" truncate>
        {`${role()} · ${part()} · ${formatRelative(props.entry.created, props.now)}${status() ? ` · ${status()}` : ""}`}
      </text>
    </box>
  )
}
