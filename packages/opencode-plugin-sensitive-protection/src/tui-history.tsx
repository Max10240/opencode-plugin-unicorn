import type { Context } from "@opencode/plugin/tui/context"
import { TextAttributes, type ScrollBoxRenderable } from "@opentui/core"
import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js"
import { ProtectionRpc, type ProtectionFileInfo, type ProtectionFilesResult, type ProtectionHistoryResult, type ProtectionHit, type ProtectionMatch, type ProtectionPendingResult, type ProtectionRequest } from "./rpc.js"

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

export type ProtectionFilesStore = {
  readonly files: () => ProtectionFileInfo[]
  readonly loading: () => boolean
  readonly error: () => string | undefined
  readonly refreshedAt: () => number | undefined
  readonly load: () => Promise<void>
  readonly dispose: () => void
}

export function createProtectionFilesStore(context: Context): ProtectionFilesStore {
  const [files, setFiles] = createSignal<ProtectionFileInfo[]>([])
  const [loading, setLoading] = createSignal(false)
  const [error, setError] = createSignal<string>()
  const [refreshedAt, setRefreshedAt] = createSignal<number>()
  let disposed = false
  let pending: Promise<void> | undefined
  let refreshTimer: ReturnType<typeof setTimeout> | undefined
  let disposeEvents: (() => void) | undefined

  const load = () => {
    if (pending) return pending
    if (typeof context.client?.rpc !== "function") {
      setError("Protected files are unavailable in this client.")
      return Promise.resolve()
    }
    pending = (async () => {
      setLoading(true)
      try {
        const result = await context.client.rpc(ProtectionRpc).files({}, { location: context.location }) as ProtectionFilesResult
        if (disposed) return
        setFiles(result.files)
        setRefreshedAt(result.refreshedAt)
        setError(undefined)
      } catch (cause) {
        if (!disposed) setError(cause instanceof Error ? cause.message : "Unable to load protected files.")
      } finally {
        if (!disposed) setLoading(false)
        pending = undefined
      }
    })()
    return pending
  }

  try {
    disposeEvents = context.client?.rpc?.(ProtectionRpc)?.events?.on("files", () => {
      if (disposed) return
      if (refreshTimer !== undefined) clearTimeout(refreshTimer)
      refreshTimer = setTimeout(() => {
        refreshTimer = undefined
        void load()
      }, 200)
    })
  } catch {
    // A client without event support can still load files manually.
  }

  return {
    files: () => files(),
    loading: () => loading(),
    error: () => error(),
    refreshedAt: () => refreshedAt(),
    load,
    dispose: () => {
      disposed = true
      if (refreshTimer !== undefined) clearTimeout(refreshTimer)
      disposeEvents?.()
    },
  }
}

export type ProtectionRequestStore = {
  readonly requests: () => ProtectionRequest[]
  readonly count: () => number
  readonly loading: () => boolean
  readonly load: () => Promise<void>
  readonly resolve: (id: string, approve: boolean) => Promise<boolean>
  readonly dispose: () => void
}

export function createProtectionRequestStore(
  context: Context,
  onRequest?: (request: ProtectionRequest) => void,
): ProtectionRequestStore {
  const [requests, setRequests] = createSignal<ProtectionRequest[]>([])
  const [loading, setLoading] = createSignal(false)
  let disposed = false
  let pending: Promise<void> | undefined
  let disposeEvents: (() => void) | undefined

  const load = () => {
    if (pending) return pending
    if (typeof context.client?.rpc !== "function") return Promise.resolve()
    pending = (async () => {
      setLoading(true)
      try {
        const result = await context.client.rpc(ProtectionRpc).pending({}, { location: context.location }) as ProtectionPendingResult
        if (!disposed) {
          const known = new Set(requests().map((request) => request.id))
          setRequests(result.requests)
          for (const request of result.requests) {
            if (!known.has(request.id)) onRequest?.(request)
          }
        }
      } catch {
        if (!disposed) setRequests([])
      } finally {
        if (!disposed) setLoading(false)
        pending = undefined
      }
    })()
    return pending
  }

  try {
    disposeEvents = context.client?.rpc?.(ProtectionRpc)?.events?.on("pending", () => {
      if (!disposed) void load()
    })
  } catch {
    // A client without event support can still load requests manually.
  }

  void load()

  return {
    requests: () => requests(),
    count: () => requests().length,
    loading: () => loading(),
    load,
    resolve: async (id, approve) => {
      const result = await context.client.rpc(ProtectionRpc).resolve({ id, approve }, { location: context.location }) as { resolved: boolean }
      await load()
      return result.resolved
    },
    dispose: () => {
      disposed = true
      disposeEvents?.()
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

export function PendingProtectionChip(props: {
  context: Context
  store: ProtectionRequestStore
}) {
  const [hovered, setHovered] = createSignal(false)
  const theme = () => props.context.theme
  return (
    <Show when={props.store.count() > 0}>
      <box
        id="sensitive-protection-pending-chip"
        flexShrink={0}
        onMouseOver={() => setHovered(true)}
        onMouseOut={() => setHovered(false)}
        onMouseUp={(event) => {
          if (event.button === 0) {
            event.stopPropagation()
            openProtectionRequests(props.context, props.store)
          }
        }}
      >
        <text
          fg={hovered() ? theme().text.action.primary.base : theme().text.feedback.warning.base}
          attributes={hovered() ? TextAttributes.BOLD : undefined}
          wrapMode="none"
        >
          {`⚠ ${props.store.count()} unprotect ${props.store.count() === 1 ? "request" : "requests"} · review`}
        </text>
      </box>
    </Show>
  )
}

export function openProtectionRequests(context: Context, store: ProtectionRequestStore) {
  context.ui.dialog.show(() => <ProtectionRequestsDialog context={context} store={store} />)
}

function ProtectionRequestsDialog(props: {
  context: Context
  store: ProtectionRequestStore
}) {
  const theme = props.context.theme.surface("dialog")
  const [selected, setSelected] = createSignal<string>()
  const [confirming, setConfirming] = createSignal(false)
  let timer: ReturnType<typeof setTimeout> | undefined
  let clock: ReturnType<typeof setInterval> | undefined
  const [now, setNow] = createSignal(Date.now())

  createEffect(() => {
    const requests = props.store.requests()
    if (requests.length === 0) {
      setSelected(undefined)
      setConfirming(false)
      return
    }
    if (!requests.some((request) => request.id === selected())) setSelected(requests[0]?.id)
  })

  createEffect(() => {
    selected()
    setConfirming(false)
  })

  const selectedRequest = () => props.store.requests().find((request) => request.id === selected())

  const resolve = async (approve: boolean) => {
    const request = selectedRequest()
    if (!request) return
    try {
      await props.store.resolve(request.id, approve)
      void props.context.ui.toast.show({
        message: approve ? `Unprotected ${shortPath(request.path, props.context) ?? request.path}` : "Unprotect request rejected",
        variant: approve ? "success" : "info",
      })
    } catch (error) {
      void props.context.ui.toast.show({
        message: error instanceof Error ? error.message : "Could not resolve request",
        variant: "error",
      })
    }
  }

  props.context.keymap.layer(() => ({
    mode: "modal",
    priority: 20,
    commands: [
      { bind: "up", title: "Previous request", run: () => {
        const requests = props.store.requests()
        const index = Math.max(0, requests.findIndex((request) => request.id === selected()))
        setSelected(requests[Math.max(0, index - 1)]?.id)
      } },
      { bind: "k", title: "Previous request", run: () => {
        const requests = props.store.requests()
        const index = Math.max(0, requests.findIndex((request) => request.id === selected()))
        setSelected(requests[Math.max(0, index - 1)]?.id)
      } },
      { bind: "down", title: "Next request", run: () => {
        const requests = props.store.requests()
        const index = Math.max(0, requests.findIndex((request) => request.id === selected()))
        setSelected(requests[Math.min(requests.length - 1, index + 1)]?.id)
      } },
      { bind: "j", title: "Next request", run: () => {
        const requests = props.store.requests()
        const index = Math.max(0, requests.findIndex((request) => request.id === selected()))
        setSelected(requests[Math.min(requests.length - 1, index + 1)]?.id)
      } },
      { bind: "a", title: "Approve unprotect", run: () => {
        if (!confirming() && selectedRequest()) setConfirming(true)
      } },
      { bind: "return", title: "Confirm unprotect", run: () => {
        if (confirming()) void resolve(true)
        else setConfirming(Boolean(selectedRequest()))
      } },
      { bind: "y", title: "Confirm unprotect", run: () => {
        if (confirming()) void resolve(true)
      } },
      { bind: "n", title: "Cancel unprotect", run: () => setConfirming(false) },
      { bind: "r", title: "Reject unprotect", run: () => {
        setConfirming(false)
        void resolve(false)
      } },
      { bind: "escape", title: "Close requests", run: () => {
        if (confirming()) setConfirming(false)
        else props.context.ui.dialog.clear()
      } },
    ],
  }))

  onMount(() => {
    props.context.ui.dialog.set({ size: "large", centered: true })
    clock = setInterval(() => setNow(Date.now()), 30_000)
    void props.store.load()
  })
  onCleanup(() => {
    if (timer !== undefined) clearTimeout(timer)
    if (clock !== undefined) clearInterval(clock)
  })

  return (
    <box paddingLeft={2} paddingRight={2} gap={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text attributes={TextAttributes.BOLD} fg={theme.text.base}>Unprotect requests</text>
        <text fg={theme.text.muted}>{props.store.loading() ? "loading…" : "pending · esc close"}</text>
      </box>
      <Show
        when={props.store.requests().length > 0}
        fallback={<text fg={theme.text.muted} wrapMode="word">No pending unprotect requests.</text>}
      >
        <scrollbox focusable maxHeight={18}>
          <For each={props.store.requests()}>
            {(request) => (
              <box
                flexDirection="column"
                paddingLeft={1}
                paddingRight={1}
                backgroundColor={request.id === selected() ? theme.background.raised.high : undefined}
                onMouseUp={(event) => { if (event.button === 0) setSelected(request.id) }}
              >
                <box flexDirection="row" gap={1}>
                  <text fg={theme.text.feedback.warning.base}>●</text>
                  <text fg={request.id === selected() ? theme.text.base : theme.text.muted} attributes={request.id === selected() ? TextAttributes.BOLD : undefined} wrapMode="none" truncate>
                    {shortPath(request.path, props.context) ?? request.path}
                  </text>
                  <box flexGrow={1} />
                  <text fg={theme.text.muted}>{relativeTime(request.createdAt, now())}</text>
                </box>
                <text fg={theme.text.muted} wrapMode="word">
                  {`${sourceLabel(request.source)}${request.project ? ` · ${shortPath(request.project, props.context) ?? request.project}` : ""}${request.reason ? ` · ${cleanText(request.reason, 160)}` : ""}`}
                </text>
              </box>
            )}
          </For>
        </scrollbox>
        <Show when={selectedRequest()}>
          {(request) => (
            <Show
              when={confirming()}
              fallback={
                <box flexDirection="column" gap={0}>
                  <text fg={theme.text.base} wrapMode="word">{request().path}</text>
                  <text fg={theme.text.muted} wrapMode="word">
                    {`Source: ${sourceLabel(request().source)} · ${request().sessionID ? shortID(request().sessionID ?? "") : "no session"}`}
                  </text>
                  <text fg={theme.text.muted}>a review unprotect · r reject · esc close</text>
                </box>
              }
            >
              <box flexDirection="column" gap={0} paddingLeft={1} paddingRight={1} backgroundColor={theme.background.raised.high}>
                <text fg={theme.text.feedback.warning.base} attributes={TextAttributes.BOLD}>Remove protection from this file?</text>
                <text fg={theme.text.base} wrapMode="word">{request().path}</text>
                <text fg={theme.text.muted} wrapMode="word">
                  {`Source: ${sourceLabel(request().source)} · Session: ${request().sessionID ? shortID(request().sessionID ?? "") : "none"}${request().project ? ` · Project: ${shortPath(request().project ?? "", props.context) ?? request().project}` : ""}`}
                </text>
                <Show when={request().reason}>
                  {(reason) => <text fg={theme.text.muted} wrapMode="word">{`Reason: ${cleanText(reason(), 240)}`}</text>}
                </Show>
                <text fg={theme.text.feedback.warning.base} wrapMode="word">
                  This stays in effect for future turns. Register the file again to restore protection.
                </text>
                <text fg={theme.text.muted}>y / enter unprotect · n / esc cancel</text>
              </box>
            </Show>
          )}
        </Show>
      </Show>
      <text fg={theme.text.muted}>
        {confirming() ? "y / enter unprotect · n / esc cancel" : "↑/↓ select · a review unprotect · r reject · esc close"}
      </text>
    </box>
  )
}

type Filter = "all" | "blocked" | "redacted" | "error"
type FileFilter = "all" | "default" | "config" | "manual" | "disabled"
type View = "history" | "files"
type Scope = "all" | "session"
type SessionSummary = {
  readonly title?: string
  readonly directory?: string
  readonly parentID?: string
}
type MenuOption = { readonly value: string; readonly label: string }



export function ProtectionHistoryDialog(props: {
  context: Context
  store: ProtectionHistoryStore
  sessionID?: string
  initialScope?: Scope
}) {
  const theme = props.context.theme.surface("dialog")
  const files = createProtectionFilesStore(props.context)
  const [view, setView] = createSignal<View>("history")
  const [filter, setFilter] = createSignal<Filter>("all")
  const [fileFilter, setFileFilter] = createSignal<FileFilter>("all")
  const [fileFilterPath, setFileFilterPath] = createSignal<string>()
  const [selectedFile, setSelectedFile] = createSignal<string>()
  const [menuOpen, setMenuOpen] = createSignal(false)
  const [menuIndex, setMenuIndex] = createSignal(0)
  const [scope, setScope] = createSignal<Scope>(props.initialScope ?? (props.sessionID ? "session" : "all"))
  const [selected, setSelected] = createSignal<string>()
  const [scrollTarget, setScrollTarget] = createSignal<ScrollBoxRenderable>()
  const [loading, setLoading] = createSignal(true)
  const [error, setError] = createSignal<string>()
  const [clearArmed, setClearArmed] = createSignal(false)
  const [unprotectArmed, setUnprotectArmed] = createSignal(false)
  const [help, setHelp] = createSignal(false)
  const [now, setNow] = createSignal(Date.now())
  const [sessions, setSessions] = createSignal<Record<string, SessionSummary | null>>({})
  const requested = new Set<string>()
  let focusTimer: ReturnType<typeof setTimeout> | undefined
  let clockTimer: ReturnType<typeof setInterval> | undefined
  let clearTimer: ReturnType<typeof setTimeout> | undefined
  let unprotectTimer: ReturnType<typeof setTimeout> | undefined

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

  const matchesFile = (hit: ProtectionHit, path: string) =>
    hit.file === path || hit.matches?.some((match) => match.file === path) === true

  const filtered = createMemo(() => {
    const value = filter()
    const path = fileFilterPath()
    return props.store.hits().filter((hit) =>
      (scope() === "all" || inSession(hit))
      && (value === "all" || hit.kind === value)
      && (path === undefined || matchesFile(hit, path))
    )
  })
  const visible = createMemo(() => filtered().slice(0, HISTORY_RENDER_LIMIT))
  const selectedHit = createMemo(() => visible().find((hit) => hit.id === selected()))

  const lastHitFor = (path: string) => {
    let latest: ProtectionHit | undefined
    for (const hit of props.store.hits()) {
      if (!matchesFile(hit, path)) continue
      if (!latest || hit.time > latest.time) latest = hit
    }
    return latest
  }

  const filteredFiles = createMemo(() => {
    const value = fileFilter()
    return files.files()
      .filter((file) => value === "all" ? file.disabled !== true : value === "disabled" ? file.disabled === true : file.source === value && file.disabled !== true)
      .sort((left, right) => {
        const leftHit = lastHitFor(left.path)?.time ?? 0
        const rightHit = lastHitFor(right.path)?.time ?? 0
        return rightHit - leftHit || left.path.localeCompare(right.path)
      })
  })
  const selectedFileInfo = createMemo(() => filteredFiles().find((file) => file.path === selectedFile()))

  const menuOptions = (): readonly MenuOption[] => view() === "history"
    ? [
        { value: "all", label: "All events" },
        { value: "blocked", label: "Blocked" },
        { value: "redacted", label: "Redacted" },
        { value: "error", label: "Error" },
      ]
    : [
        { value: "all", label: "All sources" },
        { value: "default", label: "Default" },
        { value: "config", label: "Config" },
        { value: "manual", label: "Manual" },
        { value: "disabled", label: "Disabled" },
      ]
  const currentFilter = () => view() === "history" ? filter() : fileFilter()
  const currentFilterLabel = () => menuOptions().find((option) => option.value === currentFilter())?.label ?? "All"
  const openFilterMenu = () => {
    const options = menuOptions()
    const index = options.findIndex((option) => option.value === currentFilter())
    setMenuIndex(index < 0 ? 0 : index)
    setMenuOpen(true)
  }
  const applyFilterMenu = () => {
    const option = menuOptions()[menuIndex()]
    if (option) {
      if (view() === "history") setFilter(option.value as Filter)
      else setFileFilter(option.value as FileFilter)
    }
    setMenuOpen(false)
  }
  const resetFilter = () => {
    if (view() === "history") {
      setFilter("all")
      setFileFilterPath(undefined)
    } else {
      setFileFilter("all")
    }
    setMenuOpen(false)
  }

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
    const entries = filteredFiles()
    if (entries.length === 0) {
      if (selectedFile() !== undefined) setSelectedFile(undefined)
      return
    }
    if (!entries.some((file) => file.path === selectedFile())) setSelectedFile(entries[0]?.path)
  })

  createEffect(() => {
    const index = view() === "history"
      ? visible().findIndex((hit) => hit.id === selected())
      : filteredFiles().findIndex((file) => file.path === selectedFile())
    const box = scrollTarget()
    if (index < 0 || !box) return
    const id = view() === "history" ? `protection-hit-${index}` : `protection-file-${index}`
    const timer = setTimeout(() => {
      if (!box.isDestroyed) box.scrollChildIntoView(id)
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
    if (menuOpen()) {
      const length = menuOptions().length
      if (length === 0) return
      setMenuIndex((index) => Math.max(0, Math.min(length - 1, index + delta)))
      return
    }
    if (view() === "files") {
      const entries = filteredFiles()
      if (entries.length === 0) return
      const index = Math.max(0, entries.findIndex((file) => file.path === selectedFile()))
      setSelectedFile(entries[Math.max(0, Math.min(entries.length - 1, index + delta))]?.path)
      return
    }
    const entries = visible()
    if (entries.length === 0) return
    const index = Math.max(0, entries.findIndex((hit) => hit.id === selected()))
    setSelected(entries[Math.max(0, Math.min(entries.length - 1, index + delta))]?.id)
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

  const fileForHit = (hit: ProtectionHit | undefined) => hit?.file ?? hit?.matches?.find((match) => match.file)?.file

  const switchView = (next?: View) => {
    const target = next ?? (view() === "history" ? "files" : "history")
    setMenuOpen(false)
    if (target === "files") {
      const file = fileForHit(selectedHit())
      if (file) {
        setSelectedFile(file)
        setFileFilter("all")
      }
      setView("files")
      void files.load()
      return
    }
    setView("history")
  }

  const openFileHistory = () => {
    const file = selectedFileInfo()
    if (!file) {
      void props.context.ui.toast.show({ message: "Select a protected file", variant: "warning" })
      return
    }
    setFileFilterPath(file.path)
    setFilter("all")
    setView("history")
    setMenuOpen(false)
  }

  const copyFile = () => {
    const file = selectedFileInfo()
    if (!file) {
      void props.context.ui.toast.show({ message: "Select a protected file to copy", variant: "warning" })
      return
    }
    const latest = lastHitFor(file.path)
    const text = [
      "Sensitive protection file",
      `File: ${file.path}`,
      `Source: ${sourceLabel(file.source)}`,
      ...(file.format === undefined ? [] : [`Format: ${file.format}`]),
      ...(file.label === undefined ? [] : [`Label: ${file.label}`]),
      ...(file.project === undefined ? [] : [`Project: ${file.project}`]),
      ...(file.disabled ? ["State: disabled"] : file.invalid ? [`State: error · ${file.invalid}`] : ["State: protected"]),
      ...(file.keys.length === 0 ? ["Keys: none"] : ["Keys:", ...file.keys.map((key) => `- ${key}`)]),
      ...(file.keyID === undefined ? [] : [`Key ID: ${file.keyID}`]),
      ...(latest === undefined ? [] : [`Last hit: ${new Date(latest.time).toISOString()}`]),
      "Secret values are never included in this report.",
    ].join("\n")
    let copied = false
    try {
      copied = props.context.renderer.copyToClipboardOSC52(text)
    } catch {}
    if (!copied) {
      void props.context.ui.toast.show({ message: "Could not copy file details", variant: "error" })
      return
    }
    void props.context.ui.toast.show({ message: "Copied protected file", variant: "success" })
  }

  const copy = () => {
    if (view() === "files") {
      copyFile()
      return
    }
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

  const unprotectSelected = async () => {
    const file = selectedFileInfo()
    if (!file) {
      void props.context.ui.toast.show({ message: "Select a protected file", variant: "warning" })
      return
    }
    if (!unprotectArmed()) {
      setUnprotectArmed(true)
      if (unprotectTimer !== undefined) clearTimeout(unprotectTimer)
      unprotectTimer = setTimeout(() => {
        unprotectTimer = undefined
        setUnprotectArmed(false)
      }, 3_000)
      return
    }
    setUnprotectArmed(false)
    if (unprotectTimer !== undefined) {
      clearTimeout(unprotectTimer)
      unprotectTimer = undefined
    }
    try {
      if (file.disabled) {
        await props.context.client.rpc(ProtectionRpc).restore({ path: file.path }, { location: props.context.location })
        void props.context.ui.toast.show({ message: "Protection restored", variant: "success" })
      } else {
        const result = await props.context.client.rpc(ProtectionRpc).unprotect({ path: file.path }, { location: props.context.location }) as { removed: boolean; disabled: boolean }
        void props.context.ui.toast.show({
          message: result.disabled ? "Protection disabled" : "Protection removed",
          variant: "success",
        })
      }
      await files.load()
    } catch (error) {
      void props.context.ui.toast.show({
        message: error instanceof Error ? error.message : "Could not update protection",
        variant: "error",
      })
    }
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
      { bind: "up", title: "Previous protection item", run: () => move(-1) },
      { bind: "down", title: "Next protection item", run: () => move(1) },
      { bind: "k", title: "Previous protection item", run: () => move(-1) },
      { bind: "j", title: "Next protection item", run: () => move(1) },
      { bind: "t", title: "Open protection filter", run: openFilterMenu },
      { bind: "ctrl+t", title: "Open protection filter", run: openFilterMenu },
      { bind: "0", title: "Reset protection filter", run: resetFilter },
      { bind: "f", title: "Switch protection view", run: () => switchView() },
      { bind: "s", title: "Toggle protection session scope", run: () => {
        if (view() === "files") {
          void props.context.ui.toast.show({ message: "Protected files are global", variant: "warning" })
          return
        }
        toggleScope()
      } },
      { bind: "backspace", title: "Clear protection file filter", run: () => setFileFilterPath(undefined) },
      { bind: "return", title: "Open selected protection item", run: () => {
        if (menuOpen()) {
          applyFilterMenu()
        } else if (view() === "files") {
          openFileHistory()
        } else {
          openSession()
        }
      } },
      { bind: "u", title: "Unprotect or restore selected file", run: () => {
        if (view() !== "files") {
          void props.context.ui.toast.show({ message: "Open Protected files to unprotect", variant: "warning" })
          return
        }
        void unprotectSelected()
      } },
      { bind: "c", title: "Copy protection event", run: copy },
      { bind: "ctrl+y", title: "Copy protection event", run: copy },
      { bind: "?", title: "Toggle protection help", run: () => setHelp((value) => !value) },
      { bind: "x", title: "Clear protection history", run: () => {
        if (view() === "files") {
          void props.context.ui.toast.show({ message: "Clear history from the History view", variant: "warning" })
          return
        }
        void clear()
      } },
      { bind: "r", title: "Reload protection history", run: () => {
        if (view() === "files") void files.load()
        else reload()
      } },
      { bind: "escape", title: "Close protection history", run: () => {
        if (help()) {
          setHelp(false)
          return
        }
        if (menuOpen()) {
          setMenuOpen(false)
          return
        }
        if (view() === "history" && fileFilterPath() !== undefined) {
          setFileFilterPath(undefined)
          return
        }
        props.context.ui.dialog.clear()
      } },
    ],
  }))

  onMount(() => {
    props.context.ui.dialog.set({ size: "large", centered: true })
    focusTimer = setTimeout(() => scrollTarget()?.focus(), 50)
    clockTimer = setInterval(() => setNow(Date.now()), 30_000)
    void load()
  })

  onCleanup(() => {
    files.dispose()
    if (focusTimer !== undefined) clearTimeout(focusTimer)
    if (clockTimer !== undefined) clearInterval(clockTimer)
    if (clearTimer !== undefined) clearTimeout(clearTimer)
    if (unprotectTimer !== undefined) clearTimeout(unprotectTimer)
  })

  const summaryLine = () => {
    if (view() === "files") {
      const keys = filteredFiles().reduce((total, file) => total + file.keyCount, 0)
      const status = files.loading() ? "loading…" : files.error() ? "refresh failed" : "live"
      return `Protected now · ${currentFilterLabel()} · ${filteredFiles().length} files · ${keys} keys · ${status}`
    }
    const scopeLabel = scope() === "session" && props.sessionID ? "This session" : "All sessions"
    const shown = visible().length < filtered().length ? ` · showing ${visible().length}` : ""
    const file = fileFilterPath()
    const fileLabel = file ? ` · File: ${shortPath(file, props.context) ?? file} (backspace clear)` : ""
    return `${scopeLabel} · filter: ${filter()} · ${filtered().length}${shown}${fileLabel}`
  }

  const emptyMessage = () => {
    if (loading()) return "Loading protection events…"
    if (error()) return "Protection history is unavailable."
    if (props.store.hits().length === 0) return "No protection events yet. Values are redacted before they reach the model."
    if (scope() === "session" && props.sessionID) {
      const inScope = props.store.hits().filter(inSession)
      if (inScope.length === 0) return "No events in this session. Press s to show all sessions."
    }
    if (fileFilterPath()) return "No events match this file. Press backspace to clear the file filter."
    return "No events match this filter. Press t to choose a filter or 0 to reset."
  }

  const filesEmptyMessage = () => {
    if (files.loading()) return "Loading protected files…"
    if (files.error()) return files.error()!
    if (files.files().length === 0) return "No files are currently protected."
    return "No protected files match this filter. Press t to choose a filter or 0 to reset."
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
        <text fg={theme.text.muted}>
          {view() === "files"
            ? files.loading() ? "loading…" : files.error() ? "files unavailable" : "? help · esc close"
            : loading() ? "loading…" : error() ? "history unavailable" : "? help · esc close"}
        </text>
      </box>
      <Show when={help()}>
        <box flexDirection="column" paddingLeft={1} paddingRight={1} backgroundColor={theme.background.raised.high}>
          <text fg={theme.text.base} attributes={TextAttributes.BOLD}>Keyboard help</text>
          <text fg={theme.text.muted}>History lists redaction events; Protected files shows what is registered.</text>
          <text fg={theme.text.muted}>F switches views. T / Ctrl+T changes the filter. 0 resets it.</text>
          <text fg={theme.text.muted}>C / Ctrl+Y copies the selected event or protected file.</text>
          <text fg={theme.text.muted}>U unprotects or restores a protected file. R reloads.</text>
          <text fg={theme.text.muted}>? close help · esc close</text>
        </box>
      </Show>
      <box flexDirection="row" gap={2}>
        <box onMouseUp={(event) => { if (event.button === 0) switchView("history") }}>
          <text
            attributes={view() === "history" ? TextAttributes.BOLD : undefined}
            fg={view() === "history" ? theme.text.base : theme.text.muted}
          >History</text>
        </box>
        <box onMouseUp={(event) => { if (event.button === 0) switchView("files") }}>
          <text
            attributes={view() === "files" ? TextAttributes.BOLD : undefined}
            fg={view() === "files" ? theme.text.base : theme.text.muted}
          >Protected files</text>
        </box>
      </box>
      <text fg={theme.text.muted}>{summaryLine()}</text>
      <Show when={view() === "history" ? error() : files.error()}>
        {(value) => <text fg={theme.text.feedback.warning.base} wrapMode="word">{value()}</text>}
      </Show>
      <Show when={menuOpen()}>
        <box flexDirection="column" paddingLeft={1} paddingRight={1} backgroundColor={theme.background.raised.high}>
          <text fg={theme.text.base} attributes={TextAttributes.BOLD}>Filter</text>
          <For each={menuOptions()}>
            {(option, index) => (
              <text fg={index() === menuIndex() ? theme.text.base : theme.text.muted}>
                {`${index() === menuIndex() ? ">" : " "} ${option.label}${option.value === currentFilter() ? " (current)" : ""}`}
              </text>
            )}
          </For>
          <text fg={theme.text.muted}>↑/↓ select · enter apply · 0 all · esc cancel</text>
        </box>
      </Show>
      <scrollbox ref={(value) => setScrollTarget(value)} focusable maxHeight={18}>
        <Show
          when={view() === "history"}
          fallback={
            <Show
              when={filteredFiles().length > 0}
              fallback={<text fg={theme.text.muted} wrapMode="word">{filesEmptyMessage()}</text>}
            >
              <For each={filteredFiles()}>
                {(file, index) => (
                  <FileRow
                    file={file}
                    selected={file.path === selectedFile()}
                    theme={theme}
                    context={props.context}
                    now={now()}
                    latest={lastHitFor(file.path)}
                    onSelect={() => {
                      setSelectedFile(file.path)
                      scrollTarget()?.focus()
                    }}
                    index={index()}
                  />
                )}
              </For>
            </Show>
          }
        >
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
        </Show>
      </scrollbox>
      <Show when={view() === "history"}>
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
      </Show>
      <Show when={view() === "files"}>
        <Show when={selectedFileInfo()}>
          {(file) => (
            <box flexDirection="column" gap={0}>
              <text fg={theme.text.base} wrapMode="word">{`File: ${shortPath(file().path, props.context) ?? file().path}`}</text>
              <text fg={theme.text.muted}>{`Source: ${sourceLabel(file().source)}${file().format ? ` · ${file().format}` : ""}${file().label ? ` · ${file().label}` : ""}`}</text>
              <text fg={theme.text.muted}>{`${file().disabled ? "Disabled" : file().invalid ? `Error: ${file().invalid}` : "Protected"}${file().pending ? " · unprotect pending" : ""}${file().keyID ? ` · keyID: ${file().keyID}` : ""}`}</text>
              <Show when={file().projects && file().projects!.length > 0}>
                <text fg={theme.text.muted} wrapMode="word">{`Projects: ${file().projects!.map((project) => shortPath(project, props.context) ?? project).join(" · ")}`}</text>
              </Show>
              <Show when={file().keys.length > 0} fallback={<text fg={theme.text.muted}>Keys: none</text>}>
                <text fg={theme.text.muted}>Keys:</text>
                <For each={file().keys.slice(0, 6)}>
                  {(key) => <text fg={theme.text.muted}>{`  ${key}`}</text>}
                </For>
                <Show when={file().keys.length > 6}>
                  <text fg={theme.text.muted}>{`  +${file().keys.length - 6} more keys`}</text>
                </Show>
              </Show>
              <text fg={theme.text.muted}>
                {(() => {
                  const latest = lastHitFor(file().path)
                  return latest ? `Recent: ${absoluteTime(latest.time)}` : "Recent: no hit in this history"
                })()}
              </text>
              <text fg={theme.text.muted}>{`enter history · c/ctrl+y copy · u ${file().disabled ? "restore" : "unprotect"} · f history`}</text>
            </box>
          )}
        </Show>
      </Show>
      <text fg={unprotectArmed() || clearArmed() ? theme.text.feedback.warning.base : theme.text.muted} wrapMode="word">
        {view() === "files"
          ? unprotectArmed()
            ? "Press u again to confirm unprotect/restore"
            : "↑/↓ select · enter history · c/ctrl+y copy · u unprotect/restore · t filter · 0 all · f history · r reload · ? help"
          : clearArmed()
            ? "Press x again to clear all protection history"
            : `↑/↓ select · enter session · c/ctrl+y copy · t filter: ${filter()} · s scope · f files · 0 all · r reload · ? help`}
      </text>
    </box>
  )
}

function FileRow(props: {
  file: ProtectionFileInfo
  selected: boolean
  theme: any
  context: Context
  now: number
  latest?: ProtectionHit
  index: number
  onSelect: () => void
}) {
  const keys = () => {
    if (props.file.keys.length === 0) return "no key labels"
    const shown = props.file.keys.slice(0, 3).join(" · ")
    return props.file.keys.length > 3 ? `${shown} +${props.file.keys.length - 3}` : shown
  }
  const project = () => {
    const value = props.file.project ?? props.file.projects?.[0]
    return value ? shortPath(value, props.context) ?? value : undefined
  }
  return (
    <box
      id={`protection-file-${props.index}`}
      flexDirection="column"
      paddingLeft={1}
      paddingRight={1}
      backgroundColor={props.selected ? props.theme.background.raised.high : undefined}
      onMouseUp={(event) => {
        if (event.button === 0) props.onSelect()
      }}
    >
      <box flexDirection="row" gap={1}>
        <text fg={props.theme.text.feedback.info.base} flexShrink={0}>●</text>
        <text
          fg={props.selected ? props.theme.text.base : props.theme.text.muted}
          attributes={props.selected ? TextAttributes.BOLD : undefined}
          wrapMode="none"
          truncate
        >
          {shortPath(props.file.path, props.context) ?? props.file.path}
        </text>
        <box flexGrow={1} />
        <text fg={props.theme.text.muted} wrapMode="none" flexShrink={0}>
          {props.latest ? relativeTime(props.latest.time, props.now) : "no recent hit"}
        </text>
      </box>
      <text fg={props.selected ? props.theme.text.base : props.theme.text.muted} wrapMode="word">
        {`${sourceLabel(props.file.source)}${props.file.format ? ` · ${props.file.format}` : ""}${project() ? ` · ${project()}` : ""}${props.file.label ? ` · ${props.file.label}` : ""} · ${props.file.disabled ? "disabled" : props.file.invalid ? "error" : "protected"}${props.file.pending ? " · pending" : ""} · ${props.file.keyCount} ${props.file.keyCount === 1 ? "key" : "keys"}`}
      </text>
      <text fg={props.theme.text.muted} wrapMode="word" truncate>{keys()}</text>
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
  return value === "default" ? "default" : value
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
  return value === "manual" || value === "default" || value === "config"
}

function hash(value: string) {
  let hash = 0
  for (let index = 0; index < value.length; index++) {
    hash = (hash * 31 + value.charCodeAt(index)) | 0
  }
  return Math.abs(hash).toString(36)
}
