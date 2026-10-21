import { TextAttributes, type InputRenderable, type ScrollBoxRenderable } from "@opentui/core"
import { createEffect, createSignal, For, onCleanup, onMount, Show } from "solid-js"
import type { Context } from "@opencode/plugin/tui/context"
import type { SessionSearchController } from "./controller.js"
import type { SessionNavigator } from "./navigation.js"
import { queuedMessage, type Match, type SearchResult } from "./search.js"
import { registerKeymap } from "./keymap.js"

export function SessionSearchDialog(props: { context: Context; controller: SessionSearchController; navigator: SessionNavigator; sessionID: string; revision: () => number; lifetime: AbortController }) {
  const theme = props.context.theme.surface("dialog")
  const [query, setQuery] = createSignal("")
  const [result, setResult] = createSignal<SearchResult>({ matches: [], total: 0 })
  const [selected, setSelected] = createSignal<string>()
  const [searching, setSearching] = createSignal(false)
  const [input, setInput] = createSignal<InputRenderable>()
  const [scroll, setScroll] = createSignal<ScrollBoxRenderable>()
  let generation = 0
  let selecting = false
  const queued = (entry: Match) => queuedMessage(entry.messageID, props.context.data.session.pending.list(props.sessionID) ?? [])
  createEffect(() => {
    props.revision()
    const value = query()
    const token = ++generation
    const request = new AbortController()
    setSearching(true)
    const timer = setTimeout(() => {
      void props.controller.index.search(value, request.signal).then((next) => {
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
    props.context.ui.dialog.clear()
    try { await props.navigator.jump(props.sessionID, entry) }
    catch (error) {
      const aborted = typeof error === "object" && error !== null && "name" in error && error.name === "AbortError"
      if (!aborted) props.context.ui.toast.show({ message: error instanceof Error ? error.message : String(error), variant: "warning" })
    }
  }
  const move = (delta: number) => {
    const entries = result().matches
    const at = entries.findIndex((entry) => entry.key === selected())
    setSelected(entries[Math.max(0, Math.min(entries.length - 1, at + delta))]?.key)
  }
  registerKeymap(props.context, () => ({ mode: "modal", target: input, priority: 20, commands: [
    { bind: "up", title: "Previous result", run: () => move(-1) },
    { bind: "down", title: "Next result", run: () => move(1) },
    { bind: "return", title: "Jump to message", run: () => void choose(result().matches.find((entry) => entry.key === selected())) },
    { bind: "escape", title: "Close session search", run: () => props.context.ui.dialog.clear() },
  ] }))
  onMount(() => {
    props.context.ui.dialog.set({ size: "large", centered: true })
    input()?.focus()
    void props.controller.open(props.sessionID, props.lifetime.signal)
  })
  onCleanup(() => props.lifetime.abort())
  return <box paddingLeft={2} paddingRight={2} gap={1}>
    <box flexDirection="row" justifyContent="space-between">
      <text attributes={TextAttributes.BOLD} fg={theme.text.base}>Search current session</text>
      <text fg={theme.text.muted}>esc close · enter jump</text>
    </box>
    <input ref={setInput} onInput={(value) => { setSelected(undefined); setQuery(value) }} onSubmit={() => void choose(result().matches.find((entry) => entry.key === selected()))}
      placeholder="Search user and agent messages..." placeholderColor={theme.text.muted} textColor={theme.text.formfield.base} focusedTextColor={theme.text.formfield.base} cursorColor={theme.text.formfield.base} />
    <text fg={theme.text.muted}>{(() => {
      props.revision()
      return props.controller.error ?? result().error ?? `${props.controller.loading || !props.controller.ready ? "Loading history · " : ""}${props.controller.index.size} text parts · ${result().matches.length}/${result().total} matches${result().total > 100 ? " · narrow your query" : ""}`
    })()}</text>
    <scrollbox ref={setScroll} maxHeight={18} scrollbarOptions={{ visible: false }}>
      <Show when={result().matches.length} fallback={<text fg={theme.text.muted}>{searching() ? "Searching..." : "No matching dialogue"}</text>}>
        <For each={result().matches}>{(entry, index) => <box id={`session-search-result-${index()}`} paddingLeft={1} paddingRight={1} backgroundColor={entry.key === selected() ? theme.background.raised.high : undefined}>
          <text fg={entry.key === selected() ? theme.text.base : theme.text.muted} wrapMode="word">{`${entry.role === "user" ? "User" : `Agent${entry.agent ? ` (${entry.agent})` : ""}`} · ${entry.preview}`}</text>
          <text fg={theme.text.muted} wrapMode="none">{`${new Date(entry.created).toLocaleString()}${entry.beforeCompaction ? " · before compaction" : ""}${entry.reverted ? " · reverted, unavailable" : ""}${queued(entry) ? " · queued, unavailable" : ""}`}</text>
        </box>}</For>
      </Show>
    </scrollbox>
  </box>
}
