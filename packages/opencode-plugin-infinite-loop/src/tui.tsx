import { Plugin } from "@opencode/plugin/tui"
import type { Context } from "@opencode/plugin/tui/context"
import { TextAttributes, type InputRenderable, type ScrollBoxRenderable } from "@opentui/core"
import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js"
import { formatDuration, parseCooldown, parseDuration, type DurationBounds } from "./duration.js"
import { MAX_COOLDOWN_MS, infiniteLoopEnabled, parseInfiniteLoopOptions, type InfiniteLoopOptions } from "./options.js"
import { InfiniteLoopRpc, type InfiniteLoopListItem, type InfiniteLoopStatusPayload } from "./rpc.js"

export const COMMAND_ID = "max10240.infinite-loop.open"
export const OVERVIEW_COMMAND_ID = "max10240.infinite-loop.overview"
export const SLASH_COMMAND = "infinite-loop"
export const OVERVIEW_SLASH_COMMAND = "infinite-loops"

type View = "current" | "all"

export default Plugin.define({
  id: "max10240.infinite-loop.tui",
  setup(context) {
    return setupInfiniteLoopTui(context)
  },
})

export function setupInfiniteLoopTui(context: Context) {
  let options: InfiniteLoopOptions
  try {
    options = parseInfiniteLoopOptions(context.options)
  } catch (error) {
    console.warn(`Infinite loop panel disabled: ${error instanceof Error ? error.message : "invalid options"}`)
    return
  }
  if (!options.enabled || !infiniteLoopEnabled(context.options)) return

  context.keymap.layer(() => ({
    mode: "global",
    priority: 10,
    commands: [
      {
        id: COMMAND_ID,
        title: "Open infinite loop",
        description: "Keep the current session working: nudge it each time it idles until the time window ends",
        group: "Session",
        bind: options.keybind === false ? false : options.keybind,
        palette: true,
        slash: { name: SLASH_COMMAND, arguments: true },
        run: (input?: string) => {
          void openInfiniteLoop(context, options, input)
        },
      },
      {
        id: OVERVIEW_COMMAND_ID,
        title: "Open infinite loops",
        description: "See and stop infinite loops across all projects",
        group: "Session",
        bind: options.overviewKeybind === false ? false : options.overviewKeybind,
        palette: true,
        // The host only dispatches argument-style TUI slash commands on submit.
        slash: { name: OVERVIEW_SLASH_COMMAND, arguments: true },
        run: () => {
          openInfiniteLoopOverview(context, options)
        },
      },
    ],
  }))

  return setupInfiniteLoopStatus(context, options)
}

export async function openInfiniteLoop(context: Context, options: InfiniteLoopOptions, input?: string): Promise<void> {
  const sessionID = currentSessionID(context)
  if (!sessionID) {
    openInfiniteLoopOverview(context, options)
    return
  }
  const raw = input?.trim()
  if (raw) {
    const parsed = parseStartArgument(raw, options)
    if (parsed.ok) {
      await start(context, sessionID, parsed.durationMs, parsed.cooldownMs)
      return
    }
    void context.ui.toast.show({ message: parsed.error, variant: "error" })
  }
  showPanel(context, options, "current", sessionID)
}

export function openInfiniteLoopOverview(context: Context, options: InfiniteLoopOptions): void {
  showPanel(context, options, "all", currentSessionID(context))
}

function showPanel(context: Context, options: InfiniteLoopOptions, view: View, sessionID?: string) {
  context.ui.dialog.show(() => (
    <InfiniteLoopPanel context={context} options={options} initialView={view} sessionID={sessionID} />
  ))
}

const statusListeners = new Set<() => void>()

function notifyLoopStatusChanged() {
  for (const listener of statusListeners) listener()
}

function setupInfiniteLoopStatus(context: Context, options: InfiniteLoopOptions): (() => void) | undefined {
  if (typeof context.ui?.slot !== "function") return
  try {
    return context.ui.slot({
      append: "prompt.footer.status",
      render: (input) => <InfiniteLoopStatusChip context={context} options={options} sessionID={input.sessionID} />,
    })
  } catch {
    // The panel and slash commands still work without a footer slot.
    return
  }
}

function InfiniteLoopStatusChip(props: { context: Context; options: InfiniteLoopOptions; sessionID?: string }) {
  const theme = props.context.theme
  const [status, setStatus] = createSignal<InfiniteLoopStatusPayload>()
  const [hovered, setHovered] = createSignal(false)
  let request = 0

  const refresh = async () => {
    const sessionID = props.sessionID
    if (!sessionID) {
      setStatus(undefined)
      return
    }
    const current = ++request
    try {
      const value = (await props.context.client.rpc(InfiniteLoopRpc).status({ sessionID })) as InfiniteLoopStatusPayload
      if (current !== request || props.sessionID !== sessionID) return
      setStatus(value.active ? value : undefined)
    } catch {
      if (current === request && props.sessionID === sessionID) setStatus(undefined)
    }
  }

  const notify = () => {
    void refresh()
  }

  createEffect(() => {
    // Re-read when the footer moves to another session.
    props.sessionID
    void refresh()
  })

  onMount(() => {
    statusListeners.add(notify)
    void refresh()
    // Remaining time is minute-granularity; the badge itself refreshes once a minute.
    const timer = setInterval(() => void refresh(), 60_000)
    let stopEvents: (() => void) | undefined
    if (typeof props.context.data?.listen === "function") {
      try {
        stopEvents = props.context.data.listen(({ details }) => {
          if (!details.type.startsWith("session.execution.")) return
          const sessionID = (details.data as { sessionID?: string } | undefined)?.sessionID
          if (sessionID === props.sessionID) void refresh()
        })
      } catch {
        // The minute timer still keeps the badge current.
      }
    }
    onCleanup(() => {
      statusListeners.delete(notify)
      clearInterval(timer)
      stopEvents?.()
    })
  })

  const remaining = () => {
    const deadline = status()?.deadline
    if (deadline === undefined) return ""
    return formatDuration(Math.max(0, deadline - Date.now()))
  }

  const label = () => {
    const value = status()
    if (!value?.active) return ""
    const time = remaining()
    const phase = value.phase === "paused" ? "PAUSED" : "LOOP"
    return time ? `∞ ${phase} · ${time}` : `∞ ${phase}`
  }

  const color = () =>
    status()?.phase === "paused" ? theme.text.feedback.warning.base : theme.text.action.primary.base

  return (
    <Show when={status()?.active}>
      <box
        id="infinite-loop-status-chip"
        flexShrink={0}
        paddingLeft={1}
        paddingRight={1}
        backgroundColor={theme.background.raised.high}
        onMouseOver={() => setHovered(true)}
        onMouseOut={() => setHovered(false)}
        onMouseUp={(event) => {
          if (event.button !== 0 || !props.sessionID) return
          event.stopPropagation()
          showPanel(props.context, props.options, "current", props.sessionID)
        }}
      >
        <text
          fg={hovered() ? theme.text.action.primary.base : color()}
          attributes={TextAttributes.BOLD}
          wrapMode="none"
        >
          {label()}
        </text>
      </box>
    </Show>
  )
}

function currentSessionID(context: Context): string | undefined {
  const route = context.ui.router.current()
  return route.type === "session" ? route.sessionID : undefined
}

function parseStartArgument(
  raw: string,
  options: InfiniteLoopOptions,
): { ok: true; durationMs: number; cooldownMs?: number } | { ok: false; error: string } {
  const tokens = raw.split(/\s+/).filter(Boolean)
  const cooldownToken = tokens.find((token) => token.startsWith("cooldown="))
  const durations = tokens.filter((token) => !token.startsWith("cooldown="))
  if (durations.length !== 1) {
    return { ok: false, error: "Use /infinite-loop 90m or /infinite-loop 90m cooldown=5m" }
  }
  const duration = parseDuration(durations[0]!, {
    minMs: options.minDurationMs,
    maxMs: options.maxDurationMs,
  })
  if (!duration.ok) return duration
  if (cooldownToken === undefined) return { ok: true, durationMs: duration.ms }
  const value = cooldownToken.slice("cooldown=".length).trim()
  if (!value) return { ok: true, durationMs: duration.ms }
  const cooldown = parseCooldown(value, { minMs: 0, maxMs: MAX_COOLDOWN_MS })
  if (!cooldown.ok) return cooldown
  return { ok: true, durationMs: duration.ms, cooldownMs: cooldown.ms }
}

async function start(context: Context, sessionID: string, durationMs: number, cooldownMs?: number): Promise<void> {
  try {
    const status = (await context.client.rpc(InfiniteLoopRpc).start({
      sessionID,
      durationMs,
      ...(cooldownMs === undefined ? {} : { cooldownMs }),
    })) as InfiniteLoopStatusPayload
    notifyLoopStatusChanged()
    const effective = status.cooldownMs ?? cooldownMs ?? 0
    void context.ui.toast.show({
      message: `Infinite loop started · runs for ${formatDuration(durationMs)}${effective > 0 ? ` · cooldown ${formatDuration(effective)}` : " · no cooldown"}`,
      variant: "success",
    })
  } catch (error) {
    void context.ui.toast.show({ message: describe(error), variant: "error" })
  }
}

async function stop(context: Context, sessionID: string): Promise<InfiniteLoopStatusPayload | undefined> {
  try {
    const before = (await context.client.rpc(InfiniteLoopRpc).status({ sessionID })) as InfiniteLoopStatusPayload
    if (!before.active) {
      notifyLoopStatusChanged()
      void context.ui.toast.show({ message: "Infinite loop is not running", variant: "info" })
      return before
    }
    const status = (await context.client.rpc(InfiniteLoopRpc).stop({ sessionID })) as InfiniteLoopStatusPayload
    notifyLoopStatusChanged()
    void context.ui.toast.show({ message: "Infinite loop stopped", variant: "info" })
    return status
  } catch (error) {
    void context.ui.toast.show({ message: describe(error), variant: "error" })
    return undefined
  }
}

function describe(error: unknown): string {
  const message =
    error instanceof Error
      ? error.message
      : error && typeof error === "object" && "message" in error && typeof (error as { message?: unknown }).message === "string"
        ? (error as { message: string }).message
        : undefined
  if (message === undefined) return "Infinite loop command failed"
  if (message.includes("unavailable") || message.includes("not registered") || message.includes("No registered")) {
    return "Infinite loop server is unavailable; enable features.infiniteLoop"
  }
  return message
}

function InfiniteLoopPanel(props: {
  context: Context
  options: InfiniteLoopOptions
  initialView: View
  sessionID?: string
}) {
  const theme = props.context.theme.surface("dialog")
  const bounds: DurationBounds = { minMs: props.options.minDurationMs, maxMs: props.options.maxDurationMs }
  const cooldownBounds: DurationBounds = { minMs: 0, maxMs: MAX_COOLDOWN_MS }
  const presets = props.options.presets.filter((preset) => parseDuration(preset, bounds).ok)

  const [view, setView] = createSignal<View>(props.initialView)
  const [state, setState] = createSignal<InfiniteLoopStatusPayload>()
  const [loops, setLoops] = createSignal<InfiniteLoopListItem[]>([])
  const [selected, setSelected] = createSignal(0)
  const [custom, setCustom] = createSignal("")
  const [cooldownText, setCooldownText] = createSignal("")
  const [working, setWorking] = createSignal(false)
  const [error, setError] = createSignal<string>()
  const [help, setHelp] = createSignal(false)
  const [loading, setLoading] = createSignal(true)
  const [now, setNow] = createSignal(Date.now())
  const [pendingStop, setPendingStop] = createSignal<string>()
  let durationInput: InputRenderable | undefined
  let cooldownInput: InputRenderable | undefined
  let loopList: ScrollBoxRenderable | undefined
  let refreshingCurrent = false
  let refreshingAll = false
  let scrollTimer: ReturnType<typeof setTimeout> | undefined
  let stopTimer: ReturnType<typeof setTimeout> | undefined
  const durationTarget = () => durationInput
  const cooldownTarget = () => cooldownInput
  const formBackground = theme.background?.formfield?.base ?? theme.background?.base
  const formFocusedBackground = theme.background?.formfield?.focused ?? theme.background?.raised?.high
  const formFocusedText = theme.text?.formfield?.focused ?? theme.text.formfield.base

  const clearPendingStop = () => {
    if (stopTimer !== undefined) clearTimeout(stopTimer)
    stopTimer = undefined
    setPendingStop(undefined)
  }

  const armPendingStop = (sessionID: string) => {
    clearPendingStop()
    setPendingStop(sessionID)
    stopTimer = setTimeout(() => {
      stopTimer = undefined
      setPendingStop(undefined)
    }, 3_000)
  }

  const refreshCurrent = async () => {
    if (!props.sessionID || refreshingCurrent) return
    refreshingCurrent = true
    try {
      setState((await props.context.client.rpc(InfiniteLoopRpc).status({ sessionID: props.sessionID })) as InfiniteLoopStatusPayload)
      if (view() === "current") setError(undefined)
    } catch (cause) {
      setError(describe(cause))
    } finally {
      refreshingCurrent = false
    }
  }

  const refreshAll = async () => {
    if (refreshingAll) return
    refreshingAll = true
    try {
      setLoops((await props.context.client.rpc(InfiniteLoopRpc).list({})) as InfiniteLoopListItem[])
      if (view() === "all") setError(undefined)
    } catch (cause) {
      setError(describe(cause))
    } finally {
      refreshingAll = false
      setLoading(false)
    }
  }

  const refresh = async () => {
    await Promise.all([refreshCurrent(), refreshAll()])
  }

  const startWith = async (durationMs: number, cooldownMs?: number) => {
    if (!props.sessionID) {
      void props.context.ui.toast.show({ message: "Open a session first", variant: "warning" })
      return
    }
    setWorking(true)
    clearPendingStop()
    try {
      const status = (await props.context.client.rpc(InfiniteLoopRpc).start({
        sessionID: props.sessionID,
        durationMs,
        ...(cooldownMs === undefined ? {} : { cooldownMs }),
      })) as InfiniteLoopStatusPayload
      setState(status)
      setError(undefined)
      notifyLoopStatusChanged()
      const effective = status.cooldownMs ?? cooldownMs ?? 0
      void props.context.ui.toast.show({
        message: `Infinite loop started · runs for ${formatDuration(durationMs)}${effective > 0 ? ` · cooldown ${formatDuration(effective)}` : " · no cooldown"}`,
        variant: "success",
      })
      void refreshAll()
    } catch (cause) {
      setError(describe(cause))
    } finally {
      setWorking(false)
    }
  }

  const cooldownValue = (): { ok: true; value?: number } | { ok: false } => {
    const text = cooldownText().trim()
    // An empty input means "use the server's configured default".
    if (!text) return { ok: true }
    const parsed = parseCooldown(text, cooldownBounds)
    if (!parsed.ok) {
      void props.context.ui.toast.show({ message: parsed.error, variant: "error" })
      return { ok: false }
    }
    return { ok: true, value: parsed.ms }
  }

  const startCustom = () => {
    const text = custom().trim()
    let durationMs = props.options.defaultDurationMs
    if (text) {
      const parsed = parseDuration(text, bounds)
      if (!parsed.ok) {
        void props.context.ui.toast.show({ message: parsed.error, variant: "error" })
        return
      }
      durationMs = parsed.ms
    }
    const cooldown = cooldownValue()
    if (!cooldown.ok) return
    void startWith(durationMs, cooldown.value)
  }

  const startPreset = (preset: string) => {
    const parsed = parseDuration(preset, bounds)
    if (!parsed.ok) return
    const cooldown = cooldownValue()
    if (!cooldown.ok) return
    void startWith(parsed.ms, cooldown.value)
  }

  const stopCurrent = async () => {
    if (!props.sessionID || working()) return
    setWorking(true)
    try {
      setState((await stop(props.context, props.sessionID)) ?? state())
      clearPendingStop()
      void refreshAll()
    } finally {
      setWorking(false)
    }
  }

  const stopSelected = async () => {
    const item = selectedItem()
    if (!item || working()) return
    setWorking(true)
    try {
      await stop(props.context, item.sessionID)
      clearPendingStop()
      await Promise.all([refreshAll(), item.sessionID === props.sessionID ? refreshCurrent() : Promise.resolve()])
    } finally {
      setWorking(false)
    }
  }

  const requestStopCurrent = () => {
    if (!props.sessionID || working() || state()?.active !== true) return
    if (pendingStop() === props.sessionID) {
      clearPendingStop()
      void stopCurrent()
      return
    }
    armPendingStop(props.sessionID)
  }

  const requestStopSelected = () => {
    const item = selectedItem()
    if (!item || working()) return
    if (pendingStop() === item.sessionID) {
      clearPendingStop()
      void stopSelected()
      return
    }
    armPendingStop(item.sessionID)
  }

  const stopAll = async () => {
    clearPendingStop()
    const items = loops()
    if (items.length === 0) {
      void props.context.ui.toast.show({ message: "No running loops", variant: "info" })
      return
    }
    setWorking(true)
    const confirmed = await props.context.ui.dialog.confirm({
      title: "Stop all infinite loops?",
      message: `${items.length} ${items.length === 1 ? "loop" : "loops"} will stop.`,
      label: { confirm: "Stop all", cancel: "Cancel" },
    })
    if (confirmed) {
      await Promise.allSettled(items.map((item) => props.context.client.rpc(InfiniteLoopRpc).stop({ sessionID: item.sessionID })))
      notifyLoopStatusChanged()
      void props.context.ui.toast.show({
        message: `Stopped ${items.length} ${items.length === 1 ? "infinite loop" : "infinite loops"}`,
        variant: "info",
      })
    }
    setWorking(false)
    showPanel(props.context, props.options, "all", props.sessionID)
  }

  const toggleView = () => {
    if (view() === "all") {
      if (!props.sessionID) return
      setView("current")
      setTimeout(() => durationTarget()?.focus(), 0)
      void refreshCurrent()
      return
    }
    setView("all")
    void refreshAll()
    const index = loops().findIndex((item) => item.sessionID === props.sessionID)
    setSelected(Math.max(0, index))
    setTimeout(() => loopList?.focus(), 0)
  }

  const moveSelection = (delta: number) => {
    const count = loops().length
    if (count === 0) return
    setSelected((value) => Math.min(count - 1, Math.max(0, value + delta)))
  }

  createEffect(() => {
    const count = loops().length
    if (selected() >= count) setSelected(Math.max(0, count - 1))
  })

  createEffect(() => {
    selected()
    view()
    clearPendingStop()
  })

  createEffect(() => {
    const item = loops()[selected()]
    if (!item || !loopList) return
    if (scrollTimer !== undefined) clearTimeout(scrollTimer)
    scrollTimer = setTimeout(() => {
      scrollTimer = undefined
      const box = loopList
      if (box && !box.isDestroyed) box.scrollChildIntoView(item.sessionID)
    }, 0)
  })

  createEffect(() => {
    props.context.ui.dialog.set({ size: view() === "all" ? "large" : "medium", centered: true })
  })

  onMount(() => {
    void refresh()
    setTimeout(() => {
      if (view() === "all") loopList?.focus()
      else durationTarget()?.focus()
    }, 0)
    const ticker = setInterval(() => {
      setNow(Date.now())
      void refresh()
    }, 1_000)
    onCleanup(() => {
      clearInterval(ticker)
      if (scrollTimer !== undefined) clearTimeout(scrollTimer)
      if (stopTimer !== undefined) clearTimeout(stopTimer)
    })
  })

  const currentTitle = () => {
    if (!props.sessionID) return ""
    return props.context.data.session.get(props.sessionID)?.title ?? props.sessionID
  }

  const clock = (timestamp: number | undefined) => {
    if (timestamp === undefined) return "--:--"
    const date = new Date(timestamp)
    return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`
  }

  const remaining = (timestamp: number | undefined) => {
    if (timestamp === undefined) return ""
    return formatDuration(Math.max(0, timestamp - now()))
  }

  const sentLabel = (count: number | undefined) => {
    const sent = count ?? 0
    return `${sent} ${sent === 1 ? "nudge" : "nudges"}`
  }

  const currentHeadline = () => {
    const value = state()
    if (!value?.active) return "This session  ○ Not running"
    return `This session  ● Running · sent ${sentLabel(value.sentCount)}`
  }

  const currentDetails = () => {
    const value = state()
    if (!value) return ["This session has no infinite loop."]
    if (value.active) {
      const cooldown =
        value.cooldownMs === undefined
          ? ""
          : value.cooldownMs > 0
            ? ` · cooldown ${formatDuration(value.cooldownMs)}`
            : " · no cooldown"
      const lines = [`ends ${clock(value.deadline)} · ${remaining(value.deadline)} left${cooldown}`]
      if (value.phase === "paused") {
        lines.push("Paused after manual interrupt · resumes after the next normal turn")
      } else if (value.cooldownUntil !== undefined && value.cooldownUntil > now()) {
        lines.push(`Cooling down · next nudge in ${remaining(value.cooldownUntil)}`)
      } else if (value.nextNudgeAt !== undefined && value.nextNudgeAt > now()) {
        lines.push(`Nudge in ${remaining(value.nextNudgeAt)}`)
      } else if (value.phase === "checking") {
        lines.push("Checking background work…")
      } else {
        lines.push("Waiting for this session to go idle…")
      }
      return lines
    }
    if (value.outcome) {
      const sent = value.outcome.sentCount ?? 0
      return [
        `${value.outcome.reason === "expired" ? "Expired" : "Stopped"} at ${clock(value.outcome.at)}${sent > 0 ? ` · sent ${sentLabel(sent)}` : ""}`,
      ]
    }
    return ["This session has no infinite loop."]
  }

  const durationPreview = createMemo(() => {
    const text = custom().trim()
    return text ? parseDuration(text, bounds) : undefined
  })

  const cooldownPreview = createMemo(() => {
    const text = cooldownText().trim()
    return text ? parseCooldown(text, cooldownBounds) : undefined
  })

  const grouped = createMemo(() => {
    const groups: Array<{ directory: string; items: InfiniteLoopListItem[] }> = []
    const byDirectory = new Map<string, InfiniteLoopListItem[]>()
    for (const item of loops()) {
      const directory = item.directory ?? ""
      const list = byDirectory.get(directory) ?? []
      list.push(item)
      byDirectory.set(directory, list)
    }
    for (const [directory, items] of byDirectory) groups.push({ directory, items })
    return groups
  })

  const selectedItem = () => loops()[selected()]

  const phaseLabel = (item: InfiniteLoopListItem) => {
    if (item.phase === "paused") return "paused"
    if (item.cooldownUntil !== undefined && item.cooldownUntil > now()) return `cooling ${remaining(item.cooldownUntil)}`
    if (item.nextNudgeAt !== undefined && item.nextNudgeAt > now()) return `next ${remaining(item.nextNudgeAt)}`
    if (item.phase === "checking") return "checking"
    return "waiting"
  }

  // Every printable key belongs to the inputs. Panel actions are Ctrl combos so they
  // behave the same whether the duration input, cooldown input, or loop list has focus.
  props.context.keymap.layer(() => ({
    mode: "modal",
    priority: 20,
    commands: [
      {
        bind: "escape",
        title: "Close infinite loop",
        run: () => {
          if (help()) setHelp(false)
          else props.context.ui.dialog.clear()
        },
      },
      { bind: "f1", title: "Toggle infinite loop help", run: () => { setHelp((value) => !value) } },
      { bind: "ctrl+a", title: "Toggle all infinite loops", run: toggleView, enabled: () => props.sessionID !== undefined },
      {
        bind: "ctrl+d",
        title: view() === "all" ? "Stop selected infinite loop" : "Stop this infinite loop",
        enabled: () => !working() && (view() === "all" ? selectedItem() !== undefined : state()?.active === true),
        run: () => {
          if (view() === "all") requestStopSelected()
          else requestStopCurrent()
        },
      },
      { bind: "ctrl+shift+d", title: "Stop all infinite loops", enabled: () => view() === "all" && !working(), run: () => void stopAll() },
      { bind: "ctrl+r", title: "Refresh infinite loops", enabled: () => view() === "all", run: () => void refresh() },
      { bind: "up", title: "Previous infinite loop", enabled: () => view() === "all", run: () => moveSelection(-1) },
      { bind: "down", title: "Next infinite loop", enabled: () => view() === "all", run: () => moveSelection(1) },
    ],
  }))
  props.context.keymap.layer(() => ({
    mode: "modal",
    priority: 20,
    target: durationTarget,
    enabled: () => view() === "current",
    commands: [
      { bind: "return", title: "Start infinite loop", enabled: () => !working(), run: startCustom },
      { bind: "tab", title: "Focus cooldown", run: () => cooldownTarget()?.focus() },
      { bind: "shift+tab", title: "Focus cooldown", run: () => cooldownTarget()?.focus() },
      { bind: "f1", title: "Toggle infinite loop help", run: () => { setHelp((value) => !value) } },
    ],
  }))
  props.context.keymap.layer(() => ({
    mode: "modal",
    priority: 20,
    target: cooldownTarget,
    enabled: () => view() === "current",
    commands: [
      { bind: "return", title: "Start infinite loop", enabled: () => !working(), run: startCustom },
      { bind: "tab", title: "Focus duration", run: () => durationTarget()?.focus() },
      { bind: "shift+tab", title: "Focus duration", run: () => durationTarget()?.focus() },
      { bind: "f1", title: "Toggle infinite loop help", run: () => { setHelp((value) => !value) } },
    ],
  }))

  return (
    <box paddingLeft={2} paddingRight={2} gap={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text attributes={TextAttributes.BOLD} fg={theme.text.base}>
          {view() === "all" ? `Infinite loops${loops().length > 0 ? ` · ${loops().length} running` : ""}` : "Infinite loop"}
        </text>
        <text fg={theme.text.muted}>f1 help · esc close</text>
      </box>
      <Show when={view() === "current"}>
        <text fg={theme.text.muted} wrapMode="word">{currentTitle()}</text>
        <text fg={theme.text.base}>{currentHeadline()}</text>
        <Show when={props.sessionID !== undefined && pendingStop() === props.sessionID}>
          <text fg={theme.text.feedback?.warning?.base ?? theme.text.base}>Press ctrl+d again to stop this loop.</text>
        </Show>
        <For each={currentDetails()}>{(line) => <text fg={theme.text.muted} wrapMode="word">{line}</text>}</For>
      </Show>
      <Show when={view() === "all"}>
        <text fg={theme.text.muted}>All projects</text>
      </Show>
      <Show when={error()}>
        {(message) => <text fg={theme.text.feedback?.error?.base ?? theme.text.base} wrapMode="word">{message()}</text>}
      </Show>
      <Show when={help()}>
        <box flexDirection="column" paddingLeft={1} paddingRight={1} backgroundColor={theme.background.raised.high}>
          <text fg={theme.text.base} attributes={TextAttributes.BOLD}>Keyboard help</text>
          <text fg={theme.text.muted}>enter start · tab duration / cooldown · click a preset to start it</text>
          <text fg={theme.text.muted}>ctrl+d stop this loop (press twice) · ctrl+a all projects / this session</text>
          <text fg={theme.text.muted}>↑/↓ select · ctrl+d stop selected (twice) · ctrl+shift+d stop all · ctrl+r refresh</text>
          <text fg={theme.text.muted}>f1 help · esc close</text>
        </box>
      </Show>
      <Show when={view() === "current"}>
        <text fg={theme.text.base} attributes={TextAttributes.BOLD}>Start</text>
        <Show when={presets.length > 0}>
          <box flexDirection="row" gap={1}>
            <For each={presets}>
              {(preset) => (
                <box
                  id={`infinite-loop-preset-${preset}`}
                  paddingLeft={1}
                  paddingRight={1}
                  backgroundColor={theme.background.raised.high}
                  onMouseUp={() => {
                    if (!working()) startPreset(preset)
                  }}
                >
                  <text fg={theme.text.base}>{preset}</text>
                </box>
              )}
            </For>
          </box>
        </Show>
        <input
          ref={(value: InputRenderable) => {
            durationInput = value
            setTimeout(() => value.focus(), 0)
          }}
          onInput={setCustom}
          placeholder={`e.g. 90m, 2h, 1h30m · empty = ${formatDuration(props.options.defaultDurationMs)}`}
          placeholderColor={theme.text.muted}
          backgroundColor={formBackground}
          focusedBackgroundColor={formFocusedBackground}
          textColor={theme.text.formfield.base}
          focusedTextColor={formFocusedText}
          cursorColor={theme.text.formfield.base}
        />
        <Show
          when={durationPreview()}
          fallback={<text fg={theme.text.muted}>Bare numbers are hours: 2 = 2h</text>}
        >
          {(parsed) => (
            <Show
              when={parsed().ok}
              fallback={<text fg={theme.text.feedback?.error?.base ?? theme.text.base} wrapMode="word">{(parsed() as { error: string }).error}</text>}
            >
              <text fg={theme.text.base} attributes={TextAttributes.BOLD}>= {formatDuration((parsed() as { ms: number }).ms)}</text>
            </Show>
          )}
        </Show>
        <input
          ref={(value: InputRenderable) => { cooldownInput = value }}
          onInput={setCooldownText}
          placeholder={`Cooldown · e.g. 5m, 1h, 0 · empty = ${formatDuration(props.options.cooldownMs)}`}
          placeholderColor={theme.text.muted}
          backgroundColor={formBackground}
          focusedBackgroundColor={formFocusedBackground}
          textColor={theme.text.formfield.base}
          focusedTextColor={formFocusedText}
          cursorColor={theme.text.formfield.base}
        />
        <Show
          when={cooldownPreview()}
          fallback={<text fg={theme.text.muted}>{`Cooldown default: ${formatDuration(props.options.cooldownMs)} · bare numbers are minutes: 5 = 5m`}</text>}
        >
          {(parsed) => (
            <Show
              when={parsed().ok}
              fallback={<text fg={theme.text.feedback?.error?.base ?? theme.text.base} wrapMode="word">{(parsed() as { error: string }).error}</text>}
            >
              <text fg={theme.text.base} attributes={TextAttributes.BOLD}>
                {(parsed() as { ms: number }).ms === 0 ? "= no cooldown" : `= ${formatDuration((parsed() as { ms: number }).ms)}`}
              </text>
            </Show>
          )}
        </Show>
        <text fg={theme.text.muted} wrapMode="word">Message: {props.options.message}</text>
        <text fg={theme.text.muted} wrapMode="word">
          {`${state()?.active ? "ctrl+d stop (twice) · " : ""}ctrl+a all projects · enter start · tab duration/cooldown · click preset · f1 help · esc close`}
        </text>
      </Show>
      <Show when={view() === "all"}>
        <Show when={loading() && loops().length === 0} fallback={
          <Show when={loops().length > 0} fallback={<text fg={theme.text.muted}>No running loops. Start one with /infinite-loop.</text>}>
            <scrollbox ref={(value: ScrollBoxRenderable) => { loopList = value }} focusable maxHeight={18}>
              <For each={grouped()}>
                {(group) => (
                  <>
                    <text fg={theme.text.muted}>{group.directory ? props.context.ui.format.path(group.directory) : "Unknown project"}</text>
                    <For each={group.items}>
                      {(item) => (
                        <LoopRow
                          item={item}
                          selected={item.sessionID === selectedItem()?.sessionID}
                          current={item.sessionID === props.sessionID}
                          theme={theme}
                          now={now()}
                          phaseLabel={phaseLabel(item)}
                          pending={item.sessionID === pendingStop()}
                        />
                      )}
                    </For>
                  </>
                )}
              </For>
            </scrollbox>
            <text fg={theme.text.muted} wrapMode="word">↑/↓ select · ctrl+d stop selected (twice) · ctrl+shift+d stop all · ctrl+r refresh · ctrl+a this session · f1 help · esc close</text>
          </Show>
        }>
          <text fg={theme.text.muted}>Loading loops…</text>
        </Show>
      </Show>
    </box>
  )
}

function LoopRow(props: {
  item: InfiniteLoopListItem
  selected: boolean
  current: boolean
  theme: any
  now: number
  phaseLabel: string
  pending: boolean
}) {
  const title = () => props.item.title ?? props.item.sessionID
  const ends = () => {
    if (props.item.deadline === undefined) return "--:--"
    const date = new Date(props.item.deadline)
    return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`
  }
  const left = () => {
    if (props.item.deadline === undefined) return ""
    return formatDuration(Math.max(0, props.item.deadline - props.now))
  }
  const sent = () => {
    const count = props.item.sentCount ?? 0
    return `${count} ${count === 1 ? "nudge" : "nudges"}`
  }
  return (
    <box
      id={props.item.sessionID}
      flexDirection="column"
      paddingLeft={1}
      paddingRight={1}
      backgroundColor={props.selected ? props.theme.background.raised.high : undefined}
    >
      <text fg={props.selected ? props.theme.text.base : props.theme.text.muted} wrapMode="word">
        {`${props.selected ? "▸ " : "  "}${title()}${props.current ? " (current)" : ""}`}
      </text>
      <text fg={props.pending ? (props.theme.text.feedback?.warning?.base ?? props.theme.text.base) : props.theme.text.muted}>
        {props.pending
          ? "Press ctrl+d again to stop this loop."
          : `ends ${ends()} · ${left()} left · sent ${sent()} · ${props.phaseLabel}`}
      </text>
    </box>
  )
}
