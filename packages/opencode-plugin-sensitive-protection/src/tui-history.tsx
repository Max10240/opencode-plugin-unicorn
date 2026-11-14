import type { Context } from "@opencode/plugin/tui/context"
import { TextAttributes, type ScrollBoxRenderable } from "@opentui/core"
import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js"
import { ProtectionRpc, type ProtectionHistoryResult, type ProtectionHit, type ProtectionMatch } from "./rpc.js"

export const HISTORY_COMMAND_ID = "sensitive-protection.history"
export const HISTORY_SLASH_NAME = "protection-history"
const HISTORY_RENDER_LIMIT = 100
const HISTORY_MEMORY_LIMIT = 1_000
const RECENT_DURATION = 30_000

export type RecentProtectionHit = {
  readonly id: string
  readonly kind: ProtectionHit["kind"]
  readonly count: number
  readonly sessionID?: string
  readonly time: number
}

export type HistoryLoadResult = {
  readonly error?: string
  readonly limit?: number
}

export type ProtectionHistoryStore = {
  readonly hits: () => ProtectionHit[]
  readonly recent: () => RecentProtectionHit | undefined
  readonly load: () => Promise<HistoryLoadResult>
  readonly clear: () => Promise<number>
  readonly dismissRecent: () => void
  readonly dispose: () => void
}

/**
 * Keeps a bounded, metadata-only view of protection events. The server owns the
 * durable-for-this-run history; this store merges the snapshot with live events.
 */
export function createProtectionHistoryStore(
  context: Context,
  onNotify?: (hit: ProtectionHit) => void,
): ProtectionHistoryStore {
  const [hits, setHits] = createSignal<ProtectionHit[]>([])
  const [recent, setRecent] = createSignal<RecentProtectionHit>()
  const notified = new Map<string, number>()
  let recentTimer: ReturnType<typeof setTimeout> | undefined
  let disposeEvents: (() => void) | undefined
  let disposeCleared: (() => void) | undefined
  let loading: Promise<HistoryLoadResult> | undefined
  const notifications = context.options.notifications !== false

  const merge = (incoming: readonly ProtectionHit[]) => {
    if (incoming.length === 0) return
    setHits((previous) => {
      const merged = new Map(previous.map((hit) => [hit.id, hit]))
      for (const hit of incoming) {
        const existing = merged.get(hit.id)
        if (!existing || hit.time >= existing.time || hit.occurrences > existing.occurrences) merged.set(hit.id, hit)
      }
      return [...merged.values()]
        .sort((left, right) => right.firstTime - left.firstTime || right.time - left.time)
        .slice(0, HISTORY_MEMORY_LIMIT)
    })
  }

  const notify = (hit: ProtectionHit) => {
    if (!notifications) return
    const previous = notified.get(hit.id)
    if (previous !== undefined && hit.count <= previous) return
    notified.set(hit.id, hit.count)
    while (notified.size > 256) {
      const oldest = notified.keys().next().value
      if (oldest === undefined) break
      notified.delete(oldest)
    }
    const now = Date.now()
    setRecent({
      id: hit.id,
      kind: hit.kind,
      count: hit.count,
      ...(hit.sessionID === undefined ? {} : { sessionID: hit.sessionID }),
      time: now,
    })
    try {
      onNotify?.(hit)
    } catch {
      // A toast failure must not break event collection.
    }
    if (recentTimer !== undefined) clearTimeout(recentTimer)
    recentTimer = setTimeout(() => {
      recentTimer = undefined
      setRecent(undefined)
    }, RECENT_DURATION)
  }

  try {
    disposeEvents = context.client?.rpc?.(ProtectionRpc)?.events?.on("hit", (event) => {
      const hit = normalizeHit(event.data)
      if (!hit) return
      merge([hit])
      notify(hit)
    })
  } catch (error) {
    console.warn("Sensitive protection TUI events unavailable:", error)
  }
  try {
    disposeCleared = context.client?.rpc?.(ProtectionRpc)?.events?.on("cleared", () => {
      setHits([])
      notified.clear()
      setRecent(undefined)
      if (recentTimer !== undefined) {
        clearTimeout(recentTimer)
        recentTimer = undefined
      }
    })
  } catch (error) {
    console.warn("Sensitive protection clear event unavailable:", error)
  }

  return {
    hits: () => hits(),
    recent: () => recent(),
    load: () => {
      if (loading) return loading
      loading = (async () => {
        try {
          const result = await context.client.rpc(ProtectionRpc).history(
            {},
            { location: context.location },
          ) as ProtectionHistoryResult
          merge(result.hits)
          return { limit: result.limit }
        } catch (error) {
          return { error: error instanceof Error ? error.message : "Unable to load protection history." }
        } finally {
          loading = undefined
        }
      })()
      return loading
    },
    clear: async () => {
      const result = await context.client.rpc(ProtectionRpc).clear({}, { location: context.location }) as { cleared: number }
      setHits([])
      notified.clear()
      setRecent(undefined)
      if (recentTimer !== undefined) {
        clearTimeout(recentTimer)
        recentTimer = undefined
      }
      return result.cleared
    },
    dismissRecent: () => {
      if (recentTimer !== undefined) {
        clearTimeout(recentTimer)
        recentTimer = undefined
      }
      setRecent(undefined)
    },
    dispose: () => {
      disposeEvents?.()
      disposeCleared?.()
      if (recentTimer !== undefined) clearTimeout(recentTimer)
    },
  }
}

export function openProtectionHistory(
  context: Context,
  store: ProtectionHistoryStore,
  sessionID?: string,
  initialScope?: "all" | "session",
) {
  store.dismissRecent()
  context.ui.dialog.show(() => (
    <ProtectionHistoryDialog context={context} store={store} sessionID={sessionID} initialScope={initialScope} />
  ))
}

export function RecentProtectionChip(props: {
  context: Context
  store: ProtectionHistoryStore
  sessionID?: string
}) {
  const [hovered, setHovered] = createSignal(false)
  const theme = () => props.context.theme
  const recent = () => {
    const value = props.store.recent()
    if (!value) return
    if (props.sessionID && value.sessionID) {
      let same = value.sessionID === props.sessionID
      if (!same) {
        try {
          const root = props.context.data?.session?.root
          if (root) same = root(value.sessionID) === root(props.sessionID)
        } catch {}
      }
      if (!same) return
    }
    return value
  }
  const label = () => {
    const value = recent()
    if (!value) return ""
    if (value.kind === "error") return "protection error"
    if (value.kind === "blocked") return "access blocked"
    const count = value.count === 1 ? "1 value" : `${value.count} values`
    return `${count} redacted`
  }
  const tone = () => {
    const value = recent()
    return value?.kind === "blocked" || value?.kind === "error"
      ? theme().text.feedback.warning.base
      : theme().text.feedback.info.base
  }
  const open = () => {
    const value = recent()
    if (!value) return
    openProtectionHistory(props.context, props.store, value.sessionID, value.sessionID ? "session" : "all")
  }
  return (
    <Show when={recent()}>
      <box
        id="sensitive-protection-recent-chip"
        flexShrink={0}
        onMouseOver={() => setHovered(true)}
        onMouseOut={() => setHovered(false)}
        onMouseUp={(event) => {
          if (event.button === 0) {
            event.stopPropagation()
            open()
          }
        }}
      >
        <text
          fg={hovered() ? theme().text.action.primary.base : tone()}
          attributes={hovered() ? TextAttributes.BOLD : undefined}
          wrapMode="none"
        >
          {`${label()} · details`}
        </text>
      </box>
    </Show>
  )
}

type Filter = "all" | "blocked" | "redacted" | "error"
type Scope = "all" | "session"
type SessionSummary = {
  readonly title?: string
  readonly directory?: string
  readonly parentID?: string
}

const FILTERS: readonly Filter[] = ["all", "blocked", "redacted", "error"]

export function ProtectionHistoryDialog(props: {
  context: Context
  store: ProtectionHistoryStore
  sessionID?: string
  initialScope?: Scope
}) {
  const theme = props.context.theme.surface("dialog")
  const [filter, setFilter] = createSignal<Filter>("all")
  const [scope, setScope] = createSignal<Scope>(props.initialScope ?? (props.sessionID ? "session" : "all"))
  const [selected, setSelected] = createSignal<string>()
  const [scrollTarget, setScrollTarget] = createSignal<ScrollBoxRenderable>()
  const [loading, setLoading] = createSignal(true)
  const [error, setError] = createSignal<string>()
  const [clearArmed, setClearArmed] = createSignal(false)
  const [now, setNow] = createSignal(Date.now())
  const [sessions, setSessions] = createSignal<Record<string, SessionSummary | null>>({})
  const requested = new Set<string>()
  let focusTimer: ReturnType<typeof setTimeout> | undefined
  let clockTimer: ReturnType<typeof setInterval> | undefined
  let clearTimer: ReturnType<typeof setTimeout> | undefined

  const inSession = (hit: ProtectionHit) => {
    const current = props.sessionID
    if (!current) return true
    if (!hit.sessionID) return false
    try {
      const root = props.context.data?.session?.root
      return root ? root(hit.sessionID) === root(current) : hit.sessionID === current
    } catch {
      return hit.sessionID === current
    }
  }

  const filtered = createMemo(() => {
    const value = filter()
    return props.store.hits().filter((hit) =>
      (scope() === "all" || inSession(hit)) && (value === "all" || hit.kind === value)
    )
  })
  const visible = createMemo(() => filtered().slice(0, HISTORY_RENDER_LIMIT))
  const selectedHit = createMemo(() => visible().find((hit) => hit.id === selected()))

  const resolveSessions = () => {
    const ids = new Set<string>()
    for (const hit of visible()) if (hit.sessionID) ids.add(hit.sessionID)
    for (const hit of props.store.hits()) {
      if (ids.size >= 32) break
      if (hit.sessionID) ids.add(hit.sessionID)
    }
    for (const id of ids) {
      if (requested.has(id)) continue
      requested.add(id)
      try {
        const cached = props.context.data?.session?.get?.(id)
        if (cached) {
          setSessions((previous) => ({ ...previous, [id]: summaryFromSession(cached) }))
          continue
        }
      } catch {}
      try {
        const request = props.context.client?.session?.get?.({ sessionID: id })
        if (!request) {
          setSessions((previous) => ({ ...previous, [id]: null }))
          continue
        }
        void request.then((info) => {
          setSessions((previous) => ({ ...previous, [id]: info ? summaryFromSession(info) : null }))
        }).catch(() => {
          setSessions((previous) => ({ ...previous, [id]: null }))
        })
      } catch {
        setSessions((previous) => ({ ...previous, [id]: null }))
      }
    }
  }

  const load = async () => {
    setLoading(true)
    setError(undefined)
    const result = await props.store.load()
    if (result.error) setError(result.error)
    else if (result.limit === 0) setError("History is disabled by configuration (`historyLimit: 0`). New events in this TUI are shown only until it exits.")
    resolveSessions()
    setLoading(false)
  }

  const reload = () => {
    requested.clear()
    setSessions({})
    void load()
  }

  createEffect(() => {
    const entries = visible()
    if (entries.length === 0) {
      if (selected() !== undefined) setSelected(undefined)
      return
    }
    if (!entries.some((hit) => hit.id === selected())) setSelected(entries[0]?.id)
  })

  createEffect(() => {
    const index = visible().findIndex((hit) => hit.id === selected())
    const box = scrollTarget()
    if (index < 0 || !box) return
    const timer = setTimeout(() => {
      if (!box.isDestroyed) box.scrollChildIntoView(`protection-hit-${index}`)
    }, 0)
    onCleanup(() => clearTimeout(timer))
  })

  createEffect(resolveSessions)

  const summary = (id: string | undefined) => id ? sessions()[id] : undefined

  const sessionValue = (id: string | undefined) => {
    if (!id) return
    try {
      const cached = props.context.data?.session?.get?.(id)
      if (cached) return summaryFromSession(cached)
    } catch {}
    return summary(id)
  }

  const move = (delta: number) => {
    const entries = visible()
    if (entries.length === 0) return
    const index = Math.max(0, entries.findIndex((hit) => hit.id === selected()))
    setSelected(entries[Math.max(0, Math.min(entries.length - 1, index + delta))]?.id)
  }

  const cycleFilter = () => {
    const index = FILTERS.indexOf(filter())
    setFilter(FILTERS[(index + 1) % FILTERS.length]!)
  }

  const toggleScope = () => {
    if (!props.sessionID) {
      void props.context.ui.toast.show({ message: "Open a session to filter by it", variant: "warning" })
      return
    }
    setScope((value) => value === "all" ? "session" : "all")
  }

  const openSession = () => {
    const hit = selectedHit()
    if (!hit?.sessionID) {
      void props.context.ui.toast.show({ message: "This event has no session", variant: "warning" })
      return
    }
    if (sessionValue(hit.sessionID) === null) {
      void props.context.ui.toast.show({ message: "That session is no longer available", variant: "warning" })
      return
    }
    props.context.ui.dialog.clear()
    props.context.ui.router.navigate({ type: "session", sessionID: hit.sessionID })
  }

  const copy = () => {
    const hit = selectedHit()
    if (!hit) {
      void props.context.ui.toast.show({ message: "Select an event to copy", variant: "warning" })
      return
    }
    const text = copyText(hit, sessionValue(hit.sessionID), props.context)
    let copied = false
    try {
      copied = props.context.renderer.copyToClipboardOSC52(text)
    } catch {}
    if (!copied) {
      void props.context.ui.toast.show({ message: "Could not copy event details", variant: "error" })
      return
    }
    void props.context.ui.toast.show({ message: "Copied protection event", variant: "success" })
  }

  const clear = async () => {
    if (!clearArmed()) {
      setClearArmed(true)
      if (clearTimer !== undefined) clearTimeout(clearTimer)
      clearTimer = setTimeout(() => {
        clearTimer = undefined
        setClearArmed(false)
      }, 3_000)
      return
    }
    setClearArmed(false)
    if (clearTimer !== undefined) {
      clearTimeout(clearTimer)
      clearTimer = undefined
    }
    try {
      await props.store.clear()
      setSelected(undefined)
      void props.context.ui.toast.show({ message: "Protection history cleared", variant: "success" })
    } catch (cause) {
      void props.context.ui.toast.show({
        message: cause instanceof Error ? cause.message : "Could not clear protection history",
        variant: "error",
      })
    }
  }

  props.context.keymap.layer(() => ({
    mode: "modal",
    priority: 20,
    commands: [
      { bind: "up", title: "Previous protection event", run: () => move(-1) },
      { bind: "down", title: "Next protection event", run: () => move(1) },
      { bind: "k", title: "Previous protection event", run: () => move(-1) },
      { bind: "j", title: "Next protection event", run: () => move(1) },
      { bind: "tab", title: "Cycle protection event filter", run: cycleFilter },
      { bind: "s", title: "Toggle protection session scope", run: toggleScope },
      { bind: "return", title: "Open triggering session", run: openSession },
      { bind: "c", title: "Copy protection event", run: copy },
      { bind: "x", title: "Clear protection history", run: () => void clear() },
      { bind: "r", title: "Reload protection history", run: reload },
      { bind: "escape", title: "Close protection history", run: () => props.context.ui.dialog.clear() },
    ],
  }))

  onMount(() => {
    props.context.ui.dialog.set({ size: "large", centered: true })
    focusTimer = setTimeout(() => scrollTarget()?.focus(), 50)
    clockTimer = setInterval(() => setNow(Date.now()), 30_000)
    void load()
  })

  onCleanup(() => {
    if (focusTimer !== undefined) clearTimeout(focusTimer)
    if (clockTimer !== undefined) clearInterval(clockTimer)
    if (clearTimer !== undefined) clearTimeout(clearTimer)
  })

  const summaryLine = () => {
    const scopeLabel = scope() === "session" && props.sessionID ? "This session" : "All sessions"
    const filterLabel = filter() === "all" ? "all events" : `${filter()} events`
    const shown = visible().length < filtered().length ? ` · showing ${visible().length}` : ""
    return `${scopeLabel} · ${filterLabel} · ${filtered().length}${shown}`
  }

  const emptyMessage = () => {
    if (loading()) return "Loading protection events…"
    if (error()) return "Protection history is unavailable."
    if (props.store.hits().length === 0) return "No protection events yet. Values are redacted before they reach the model."
    if (scope() === "session" && props.sessionID) {
      const inScope = props.store.hits().filter(inSession)
      if (inScope.length === 0) return "No events in this session. Press s to show all sessions."
    }
    return "No events match this filter. Press tab to change it."
  }

  const sessionText = (hit: ProtectionHit) => {
    if (!hit.sessionID) return "Background · no session"
    const value = sessionValue(hit.sessionID)
    const title = value === null ? "Session unavailable" : cleanText(value?.title, 80) || "Untitled session"
    const folder = value?.directory ? shortPath(value.directory, props.context) ?? "folder unavailable" : "folder unavailable"
    const parent = value?.parentID ? " · subagent" : ""
    return `${title}${parent} · ${folder} · ${shortID(hit.sessionID)}`
  }

  return (
    <box paddingLeft={2} paddingRight={2} gap={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text attributes={TextAttributes.BOLD} fg={theme.text.base}>Sensitive protection</text>
        <text fg={theme.text.muted}>{loading() ? "loading…" : error() ? "history unavailable" : "live · esc close"}</text>
      </box>
      <text fg={theme.text.muted}>{summaryLine()}</text>
      <Show when={error()}>
        {(value) => <text fg={theme.text.feedback.warning.base} wrapMode="word">{value()}</text>}
      </Show>
      <scrollbox ref={(value) => setScrollTarget(value)} focusable maxHeight={18}>
        <Show
          when={visible().length > 0}
          fallback={
            <text fg={theme.text.muted} wrapMode="word">
              {emptyMessage()}
            </text>
          }
        >
          <For each={visible()}>
            {(hit, index) => (
              <HitRow
                hit={hit}
                selected={hit.id === selected()}
                theme={theme}
                now={now()}
                session={sessionText(hit)}
                summary={rowSummary(hit, props.context)}
                title={rowTitle(hit)}
                onSelect={() => {
                  setSelected(hit.id)
                  scrollTarget()?.focus()
                }}
                index={index()}
              />
            )}
          </For>
        </Show>
      </scrollbox>
      <Show when={selectedHit()}>
        {(hit) => (
          <box flexDirection="column" gap={0}>
            <text fg={theme.text.base} wrapMode="word">{reason(hit())}</text>
            <Show when={displayMatches(hit()).length}>
              <For each={displayMatches(hit()).slice(0, 4)}>
                {(match) => (
                  <box flexDirection="column" gap={0}>
                    <text fg={theme.text.muted} wrapMode="word">{`• ${matchText(match, props.context)} ×${match.count}${match.source ? ` · ${sourceLabel(match.source)}` : ""}`}</text>
                    <Show when={match.file}>
                      {(file) => <text fg={theme.text.muted} wrapMode="word">{`  File: ${shortPath(file(), props.context) ?? cleanText(file(), 1_024)}`}</text>}
                    </Show>
                  </box>
                )}
              </For>
              <Show when={displayMatches(hit()).length > 4}>
                <text fg={theme.text.muted}>{`+${displayMatches(hit()).length - 4} more matches`}</text>
              </Show>
            </Show>
            <text fg={theme.text.muted} wrapMode="word">
              {`${sessionText(hit())} · first ${absoluteTime(hit().firstTime)} · last ${absoluteTime(hit().time)} · ${hit().occurrences} ${hit().occurrences === 1 ? "occurrence" : "occurrences"}`}
            </text>
            <Show when={hit().file}>
              {(file) => <text fg={theme.text.muted} wrapMode="word">{`File: ${shortPath(file(), props.context) ?? "unknown"}`}</text>}
            </Show>
          </box>
        )}
      </Show>
      <text fg={clearArmed() ? theme.text.feedback.warning.base : theme.text.muted} wrapMode="word">
        {clearArmed()
          ? "Press x again to clear all protection history"
          : "↑/↓ select · enter session · c copy · tab filter · s scope · x clear all · r reload · esc close"}
      </text>
    </box>
  )
}

function HitRow(props: {
  hit: ProtectionHit
  selected: boolean
  theme: any
  now: number
  session: string
  summary: string
  title: string
  index: number
  onSelect: () => void
}) {
  const tone = () => props.hit.kind === "blocked"
    ? props.theme.text.feedback.warning.base
    : props.hit.kind === "error"
      ? props.theme.text.feedback.error.base
      : props.theme.text.feedback.info.base
  return (
    <box
      id={`protection-hit-${props.index}`}
      flexDirection="column"
      paddingLeft={1}
      paddingRight={1}
      backgroundColor={props.selected ? props.theme.background.raised.high : undefined}
      onMouseUp={(event) => {
        if (event.button === 0) props.onSelect()
      }}
    >
      <box flexDirection="row" gap={1}>
        <text fg={tone()} flexShrink={0}>●</text>
        <text
          fg={props.selected ? props.theme.text.base : props.theme.text.muted}
          attributes={props.selected ? TextAttributes.BOLD : undefined}
          wrapMode="none"
        >
          {props.title}
        </text>
        <box flexGrow={1} />
        <text fg={props.theme.text.muted} wrapMode="none" flexShrink={0}>
          {`${relativeTime(props.hit.time, props.now)}${props.hit.occurrences > 1 ? ` · ×${props.hit.occurrences}` : ""}`}
        </text>
      </box>
      <text fg={props.selected ? props.theme.text.base : props.theme.text.muted} wrapMode="word">{props.summary}</text>
      <text fg={props.theme.text.muted} wrapMode="none" truncate>{props.session}</text>
    </box>
  )
}

function normalizeHit(value: unknown): ProtectionHit | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return
  const input = value as Record<string, unknown>
  if (!isKind(input.kind) || !isSource(input.source)) return
  const time = number(input.time) ?? Date.now()
  const matches = Array.isArray(input.matches)
    ? input.matches.map(normalizeMatch).filter((match): match is ProtectionMatch => match !== undefined)
    : undefined
  const label = cleanText(string(input.label), 200)
  const file = cleanText(string(input.file), 1_024)
  const tool = cleanText(string(input.tool), 64)
  const sessionID = cleanText(string(input.sessionID), 128)
  const detail = cleanText(string(input.detail), 300)
  return {
    id: string(input.id) ?? `legacy-${hash(JSON.stringify(input))}`,
    time,
    firstTime: number(input.firstTime) ?? time,
    occurrences: Math.max(1, number(input.occurrences) ?? 1),
    kind: input.kind,
    source: input.source,
    count: Math.max(0, number(input.count) ?? 0),
    ...(label === undefined ? {} : { label }),
    ...(file === undefined ? {} : { file }),
    ...(tool === undefined ? {} : { tool }),
    ...(sessionID === undefined ? {} : { sessionID }),
    ...(detail === undefined ? {} : { detail }),
    ...(matches?.length ? { matches } : {}),
  }
}

function normalizeMatch(value: unknown): ProtectionMatch | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return
  const input = value as Record<string, unknown>
  const file = cleanText(string(input.file), 1_024)
  const label = cleanText(string(input.label), 200)
  const key = cleanText(string(input.key), 200)
  if (!file && !label && !key) return
  return {
    ...(file === undefined ? {} : { file }),
    ...(label === undefined ? {} : { label }),
    ...(isProtectionSource(input.source) ? { source: input.source } : {}),
    ...(key === undefined ? {} : { key }),
    count: Math.max(0, number(input.count) ?? 0),
  }
}

function summaryFromSession(info: {
  title?: string
  parentID?: string
  location?: { directory?: string }
}): SessionSummary {
  return {
    ...(info.title === undefined ? {} : { title: info.title }),
    ...(info.parentID === undefined ? {} : { parentID: info.parentID }),
    ...(info.location?.directory === undefined ? {} : { directory: info.location.directory }),
  }
}

function rowTitle(hit: ProtectionHit) {
  if (hit.kind === "error") return "Protection error"
  if (hit.kind === "blocked") {
    if (hit.tool === "read") return "Blocked read"
    if (hit.tool === "edit") return "Blocked edit"
    if (hit.tool === "write") return "Blocked write"
    return "Blocked access"
  }
  if (hit.source === "context") return "Model context"
  if (hit.source === "http") return "Provider request"
  if (hit.source === "read") return "File read"
  return hit.tool ? `Tool output · ${hit.tool}` : "Tool output"
}

function rowSummary(hit: ProtectionHit, context: Context) {
  if (hit.kind === "blocked") return matchText(hit.matches?.[0], context) ?? shortPath(hit.file, context) ?? cleanText(hit.label, 120) ?? "Protected file"
  if (hit.kind === "error") return `${shortPath(hit.file, context) ?? cleanText(hit.label, 120) ?? "Protected file"} · access stays blocked`
  const count = `${hit.count} ${hit.count === 1 ? "value" : "values"}`
  return `${count} · ${matchText(hit.matches?.[0], context) ?? shortPath(hit.file, context) ?? cleanText(hit.label, 120) ?? "protected content"}`
}

function displayMatches(hit: ProtectionHit) {
  return (hit.matches ?? []).filter((match) => match.count > 0)
}

function matchText(match: ProtectionMatch | undefined, context: Context) {
  if (!match) return
  const where = readableLabel(match.label, context) ?? shortPath(match.file, context)
  if (match.key && where) return `${cleanText(match.key, 120)} in ${where}`
  return cleanText(match.key, 120) ?? where
}

function sourceLabel(value: NonNullable<ProtectionMatch["source"]>) {
  return value === "builtin" ? "built-in" : value
}

function readableLabel(value: string | undefined, context: Context) {
  const label = cleanText(value, 160)
  if (!label) return
  if (label.startsWith("/") || label.startsWith("~")) return shortPath(label, context)
  return label
}

function reason(hit: ProtectionHit) {
  if (hit.kind === "blocked") return `Blocked ${hit.tool ?? "access"} to a protected file.`
  if (hit.kind === "error") {
    return `${cleanText(hit.detail, 300) ?? "The protected file could not be read or parsed."} Access stays blocked.`
  }
  if (hit.source === "context") return "Protected values were removed before the model request."
  if (hit.source === "http") return "Protected values were removed before the provider request."
  return `Protected values were removed from ${hit.tool ? `${hit.tool} output` : "tool output"}.`
}

function shortPath(value: string | undefined, context: Context) {
  if (!value) return
  const cleaned = cleanText(value, 1_024)
  if (!cleaned) return
  return cleanText(context.ui.format.path(cleaned), 1_024)
}

function cleanText(value: string | undefined, max: number) {
  if (typeof value !== "string") return
  const cleaned = value.replace(/[\u0000-\u001F\u007F-\u009F]/g, " ").trim()
  if (!cleaned) return
  return cleaned.length > max ? `${cleaned.slice(0, max - 1)}…` : cleaned
}

function copyText(hit: ProtectionHit, session: SessionSummary | undefined | null, context: Context) {
  const matches = displayMatches(hit).map((match) => {
    const line = `- ${matchText(match, context) ?? "protected value"} ×${match.count}${match.source ? ` (${sourceLabel(match.source)})` : ""}`
    const file = cleanText(match.file, 1_024)
    return file ? `${line}\n  File: ${file}` : line
  })
  return [
    "Sensitive protection event",
    `What: ${rowTitle(hit)}`,
    `Why: ${reason(hit)}`,
    `When: ${new Date(hit.time).toISOString()}`,
    `First seen: ${new Date(hit.firstTime).toISOString()}`,
    `Occurrences: ${hit.occurrences}`,
    ...(hit.tool === undefined ? [] : [`Tool: ${cleanText(hit.tool, 64)}`]),
    ...(hit.file === undefined ? [] : [`File: ${cleanText(hit.file, 1_024)}`]),
    ...(hit.label === undefined ? [] : [`Label: ${cleanText(hit.label, 200)}`]),
    ...(hit.detail === undefined ? [] : [`Detail: ${cleanText(hit.detail, 300)}`]),
    ...(matches.length === 0 ? [] : ["Matched:", ...matches]),
    ...(hit.sessionID === undefined
      ? ["Session: none"]
      : [`Session: ${cleanText(session?.title, 80) ?? "untitled"} (${hit.sessionID})`]),
    ...(session?.directory === undefined ? [] : [`Folder: ${cleanText(session.directory, 1_024)}`]),
    "Secret values are never included in this report.",
  ].join("\n")
}

function absoluteTime(value: number) {
  const date = new Date(value)
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

function relativeTime(value: number, now: number) {
  const seconds = Math.max(0, Math.floor((now - value) / 1000))
  if (seconds < 60) return "just now"
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days}d ago`
  return new Date(value).toLocaleDateString()
}

function shortID(value: string) {
  return value.length > 14 ? `${value.slice(0, 12)}…` : value
}

function pad(value: number) {
  return String(value).padStart(2, "0")
}

function number(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function string(value: unknown) {
  return typeof value === "string" && value.trim() ? value : undefined
}

function isKind(value: unknown): value is ProtectionHit["kind"] {
  return value === "blocked" || value === "redacted" || value === "error"
}

function isSource(value: unknown): value is ProtectionHit["source"] {
  return value === "read" || value === "tool" || value === "context" || value === "http" || value === "parser"
}

function isProtectionSource(value: unknown): value is NonNullable<ProtectionMatch["source"]> {
  return value === "manual" || value === "builtin" || value === "custom"
}

function hash(value: string) {
  let hash = 0
  for (let index = 0; index < value.length; index++) {
    hash = (hash * 31 + value.charCodeAt(index)) | 0
  }
  return Math.abs(hash).toString(36)
}
