import { Plugin } from "@opencode/plugin/tui"
import type { Context } from "@opencode/plugin/tui/context"
import { TextAttributes, type InputRenderable } from "@opentui/core"
import { createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js"
import { formatDuration, parseDuration, type DurationBounds } from "./duration.js"
import { deadLoopEnabled, parseDeadLoopOptions, type DeadLoopOptions } from "./options.js"
import { DeadLoopRpc, type DeadLoopStatusPayload } from "./rpc.js"

export const COMMAND_ID = "max10240.dead-loop.open"
export const SLASH_COMMAND = "deadloop"

export default Plugin.define({
  id: "max10240.dead-loop.tui",
  setup(context) {
    return setupDeadLoopTui(context)
  },
})

export function setupDeadLoopTui(context: Context) {
  let options: DeadLoopOptions
  try {
    options = parseDeadLoopOptions(context.options)
  } catch (error) {
    console.warn(`Dead loop panel disabled: ${error instanceof Error ? error.message : "invalid options"}`)
    return
  }
  if (!options.enabled || !deadLoopEnabled(context.options)) return

  context.keymap.layer(() => ({
    mode: "global",
    priority: 10,
    commands: [
      {
        id: COMMAND_ID,
        title: "Open dead loop",
        description: "Keep the current session working: nudge it each time it idles until the time window ends",
        group: "Session",
        bind: options.keybind === false ? false : options.keybind,
        palette: true,
        slash: { name: SLASH_COMMAND, arguments: true },
        run: (input?: string) => {
          void openDeadLoop(context, options, input)
        },
      },
    ],
  }))
}

export async function openDeadLoop(context: Context, options: DeadLoopOptions, input?: string): Promise<void> {
  const route = context.ui.router.current()
  if (route.type !== "session") {
    context.ui.toast.show({ message: "Open a session first", variant: "warning" })
    return
  }
  const sessionID = route.sessionID
  const raw = input?.trim()
  if (raw) {
    const parsed = parseDuration(raw, { minMs: options.minDurationMs, maxMs: options.maxDurationMs })
    if (parsed.ok) {
      await start(context, sessionID, parsed.ms)
      return
    }
    context.ui.toast.show({ message: parsed.error, variant: "error" })
  }
  context.ui.dialog.show(() => <DeadLoopPanel context={context} options={options} sessionID={sessionID} />)
}

function describe(error: unknown): string {
  const message = error instanceof Error ? error.message : error && typeof error === "object" && "message" in error && typeof (error as { message?: unknown }).message === "string"
    ? (error as { message: string }).message
    : undefined
  if (message === undefined) return "Dead loop command failed"
  if (message.includes("unavailable") || message.includes("not registered") || message.includes("No registered")) {
    return "Dead loop server is unavailable; enable features.deadLoop"
  }
  return message
}

async function start(context: Context, sessionID: string, durationMs: number): Promise<void> {
  try {
    await context.client.rpc(DeadLoopRpc).start({ sessionID, durationMs })
    context.ui.toast.show({ message: `Dead loop started · runs for ${formatDuration(durationMs)}`, variant: "success" })
  } catch (error) {
    context.ui.toast.show({ message: describe(error), variant: "error" })
  }
}

async function stop(context: Context, sessionID: string): Promise<void> {
  try {
    await context.client.rpc(DeadLoopRpc).stop({ sessionID })
    context.ui.toast.show({ message: "Dead loop stopped", variant: "info" })
  } catch (error) {
    context.ui.toast.show({ message: describe(error), variant: "error" })
  }
}

function DeadLoopPanel(props: { context: Context; options: DeadLoopOptions; sessionID: string }) {
  const theme = props.context.theme
  const bounds: DurationBounds = { minMs: props.options.minDurationMs, maxMs: props.options.maxDurationMs }
  const presets = props.options.presets.filter((preset) => parseDuration(preset, bounds).ok)

  const [state, setState] = createSignal<DeadLoopStatusPayload>()
  const [error, setError] = createSignal<string>()
  const [custom, setCustom] = createSignal("")
  const [working, setWorking] = createSignal(false)
  const [now, setNow] = createSignal(Date.now())

  const refresh = async () => {
    try {
      setState((await props.context.client.rpc(DeadLoopRpc).status({ sessionID: props.sessionID })) as DeadLoopStatusPayload)
      setError(undefined)
    } catch (cause) {
      setError(describe(cause))
    }
  }

  const startWith = async (durationMs: number) => {
    setWorking(true)
    try {
      setState((await props.context.client.rpc(DeadLoopRpc).start({ sessionID: props.sessionID, durationMs })) as DeadLoopStatusPayload)
      setError(undefined)
      props.context.ui.toast.show({ message: `Dead loop started · runs for ${formatDuration(durationMs)}`, variant: "success" })
    } catch (cause) {
      setError(describe(cause))
    } finally {
      setWorking(false)
    }
  }

  const stop = async () => {
    setWorking(true)
    try {
      setState((await props.context.client.rpc(DeadLoopRpc).stop({ sessionID: props.sessionID })) as DeadLoopStatusPayload)
      setError(undefined)
      props.context.ui.toast.show({ message: "Dead loop stopped", variant: "info" })
    } catch (cause) {
      setError(describe(cause))
    } finally {
      setWorking(false)
    }
  }

  const startCustom = () => {
    const text = custom().trim()
    if (!text) {
      void startWith(props.options.defaultDurationMs)
      return
    }
    const parsed = parseDuration(text, bounds)
    if (!parsed.ok) {
      props.context.ui.toast.show({ message: parsed.error, variant: "error" })
      return
    }
    void startWith(parsed.ms)
  }

  props.context.keymap.layer(() => ({
    mode: "modal",
    priority: 20,
    commands: [
      ...presets.slice(0, 9).map((preset, index) => ({
        bind: String(index + 1),
        title: `Start dead loop for ${preset}`,
        enabled: () => !working(),
        run: () => {
          const parsed = parseDuration(preset, bounds)
          if (parsed.ok) void startWith(parsed.ms)
        },
      })),
      { bind: "enter", title: "Start dead loop", enabled: () => !working(), run: () => startCustom() },
      { bind: "d", title: "Stop dead loop", enabled: () => !working(), run: () => void stop() },
      { bind: "escape", title: "Close dead loop", run: () => props.context.ui.dialog.clear() },
    ],
  }))

  onMount(() => {
    props.context.ui.dialog.set({ size: "medium", centered: true })
    void refresh()
    const ticker = setInterval(() => setNow(Date.now()), 500)
    onCleanup(() => clearInterval(ticker))
  })

  const remaining = () => {
    const value = state()
    if (!value?.active || value.deadline === undefined) return undefined
    return Math.max(0, value.deadline - now())
  }
  const clock = (timestamp: number) => {
    const date = new Date(timestamp)
    return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`
  }
  const preview = createMemo(() => {
    const text = custom().trim()
    return text ? parseDuration(text, bounds) : undefined
  })
  const title = () => props.context.data.session.get(props.sessionID)?.title ?? props.sessionID

  const statusLines = () => {
    const value = state()
    if (!value) return []
    if (value.active) {
      const sent = value.sentCount ?? 0
      return [
        `Running · sent ${sent} ${sent === 1 ? "nudge" : "nudges"} · ends ${clock(value.deadline ?? Date.now())} · ${formatDuration(remaining() ?? 0)} left`,
        value.nudging ? "Nudge imminent…" : "Waiting for this session to go idle…",
      ]
    }
    if (value.outcome) {
      const sent = value.outcome.sentCount ?? 0
      const summary = sent > 0 ? ` · sent ${sent} ${sent === 1 ? "nudge" : "nudges"}` : ""
      return [`${value.outcome.reason === "expired" ? "Expired" : "Stopped"} at ${clock(value.outcome.at)}${summary}`]
    }
    return ["Not running. Pick a preset (1-6), press Enter for the default duration, or type a custom one."]
  }

  return (
    <box paddingLeft={2} paddingRight={2} gap={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text attributes={TextAttributes.BOLD} fg={theme.text.base}>Dead loop</text>
        <text fg={theme.text.muted}>esc close</text>
      </box>
      <text fg={theme.text.muted} wrapMode="word">{title()}</text>
      <Show when={error()}>
        {(message) => <text fg={theme.text.feedback?.error?.base ?? theme.text.base} wrapMode="word">{message()}</text>}
      </Show>
      <For each={statusLines()}>
        {(line) => <text fg={theme.text.base} wrapMode="word">{line}</text>}
      </For>
      <text fg={theme.text.base} attributes={TextAttributes.BOLD}>Start</text>
      <Show when={presets.length > 0}>
        <text fg={theme.text.base}>{presets.map((preset, index) => `[${index + 1}] ${preset}`).join("  ")}</text>
      </Show>
      <input
        ref={(value: InputRenderable) => {
          setTimeout(() => value.focus(), 0)
        }}
        onInput={setCustom}
        placeholder={`e.g. 90m, 2h, 1h30m · empty = ${formatDuration(props.options.defaultDurationMs)}`}
        placeholderColor={theme.text.muted}
        textColor={theme.text.formfield.base}
        focusedTextColor={theme.text.formfield.base}
        cursorColor={theme.text.formfield.base}
      />
      <Show
        when={preview()}
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
      <text fg={theme.text.muted} wrapMode="word">Message: {props.options.message}</text>
      <text fg={theme.text.muted}>{`${presets.length ? "1-6 preset · " : ""}enter start · d stop · esc close`}</text>
    </box>
  )
}
