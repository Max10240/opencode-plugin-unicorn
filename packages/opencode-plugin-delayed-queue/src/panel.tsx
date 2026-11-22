/** @jsxImportSource @opentui/solid */
import { TextAttributes, type InputRenderable, type ScrollBoxRenderable } from "@opentui/core"
import type { Context } from "@opencode/plugin/tui/context"
import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js"
import type { DelayedQueueItem, DelayedQueueStatus, PauseReason } from "./controller.js"
import { DelayedQueueRpc } from "./rpc.js"

type PluginLocation = ReturnType<Context["data"]["location"]["default"]>

export function DelayedQueuePanel(props: {
  context: Context
  sessionID: string
  initial: DelayedQueueStatus
  location: PluginLocation
}) {
  const theme = props.context.theme.surface("dialog")
  const [items, setItems] = createSignal<readonly DelayedQueueItem[]>(props.initial.items)
  const [paused, setPaused] = createSignal(props.initial.paused)
  const [pauseReason, setPauseReason] = createSignal(props.initial.pauseReason)
  const [selected, setSelected] = createSignal<string | undefined>(props.initial.items[0]?.id)
  const [query, setQuery] = createSignal("")
  const [input, setInput] = createSignal<InputRenderable>()
  const [scroll, setScroll] = createSignal<ScrollBoxRenderable>()
  const [busy, setBusy] = createSignal(false)
  let disposed = false
  let focusTimer: ReturnType<typeof setTimeout> | undefined

  const filtered = createMemo(() => {
    const needle = query().trim().toLowerCase()
    const current = items()
    return needle ? current.filter((item) => item.text.toLowerCase().includes(needle)) : current
  })
  const selectedItem = () => filtered().find((item) => item.id === selected())

  const ensureSelection = () => {
    const visible = filtered()
    if (!visible.some((item) => item.id === selected())) setSelected(visible[0]?.id)
  }

  function applyState(state: DelayedQueueStatus) {
    setItems(state.items)
    setPaused(state.paused)
    setPauseReason(state.pauseReason)
  }

  createEffect(() => {
    // Re-select a visible row when the query or the queue changes.
    filtered()
    ensureSelection()
  })

  createEffect(() => {
    if (items().length === 0) props.context.ui.dialog.clear()
  })

  createEffect(() => {
    const sessionID = props.sessionID
    const rpc = props.context.client.rpc(DelayedQueueRpc)
    let active = true
    const stop = rpc.events.on("changed", (event) => {
      const data = event.data as { sessionID: string; state: DelayedQueueStatus }
      if (!active || data.sessionID !== sessionID) return
      applyState(data.state)
    })
    onCleanup(() => {
      active = false
      stop()
    })
  })

  createEffect(() => {
    const id = selected()
    // The paused banner changes the list height; keep the selection in view.
    paused()
    const box = scroll()
    if (!id || !box) return
    const timer = setTimeout(() => {
      if (!box.isDestroyed) box.scrollChildIntoView(`delayed-queue-item-${id}`)
    }, 0)
    onCleanup(() => clearTimeout(timer))
  })

  function move(delta: number) {
    const visible = filtered()
    if (visible.length === 0) return
    const current = visible.findIndex((item) => item.id === selected())
    if (current < 0) {
      setSelected(visible[0]?.id)
      return
    }
    const index = Math.max(0, Math.min(visible.length - 1, current + delta))
    setSelected(visible[index]?.id)
  }

  async function deleteSelected() {
    if (busy() || disposed) return
    const item = selectedItem()
    if (!item) return
    const visible = filtered()
    const index = visible.findIndex((entry) => entry.id === item.id)
    const next = visible[index + 1] ?? visible[index - 1]
    setBusy(true)
    try {
      const state = (await props.context.client.rpc(DelayedQueueRpc).remove(
        { sessionID: props.sessionID, ids: [item.id] },
        { location: props.location },
      )) as DelayedQueueStatus
      if (disposed) return
      applyState(state)
      const remaining = filtered()
      setSelected(next && remaining.some((entry) => entry.id === next.id) ? next.id : remaining[0]?.id)
    } catch (error) {
      if (!disposed) {
        props.context.ui.toast.show({ message: describe(error, "Could not delete the delayed prompt"), variant: "error" })
      }
    } finally {
      if (!disposed) setBusy(false)
    }
  }

  async function steerSelected() {
    if (busy() || disposed) return
    const item = selectedItem()
    if (!item) return
    setBusy(true)
    try {
      const state = (await props.context.client.rpc(DelayedQueueRpc).deliver(
        { sessionID: props.sessionID, id: item.id },
        { location: props.location },
      )) as DelayedQueueStatus
      if (disposed) return
      applyState(state)
      if (state.items.some((entry) => entry.id === item.id)) {
        props.context.ui.toast.show({ message: "Delayed prompt is still waiting", variant: "warning" })
        return
      }
      props.context.ui.dialog.clear()
    } catch (error) {
      if (!disposed) {
        props.context.ui.toast.show({ message: describe(error, "Could not send the delayed prompt"), variant: "error" })
      }
    } finally {
      if (!disposed) setBusy(false)
    }
  }

  async function togglePause() {
    if (busy() || disposed) return
    setBusy(true)
    try {
      const rpc = props.context.client.rpc(DelayedQueueRpc)
      const state = (paused()
        ? await rpc.resume({ sessionID: props.sessionID }, { location: props.location })
        : await rpc.pause({ sessionID: props.sessionID }, { location: props.location })) as DelayedQueueStatus
      if (disposed) return
      applyState(state)
      props.context.ui.toast.show({
        message: state.paused
          ? "Paused the whole delayed queue · messages stay queued"
          : "Resumed the whole delayed queue",
        variant: state.paused ? "info" : "success",
      })
    } catch (error) {
      if (!disposed) {
        props.context.ui.toast.show({ message: describe(error, "Could not change the delayed queue"), variant: "error" })
      }
    } finally {
      if (!disposed) setBusy(false)
    }
  }

  const commands = () => [
    { bind: "ctrl+d", title: "Delete selected delayed prompt", run: () => void deleteSelected() },
    { bind: "ctrl+s", title: "Steer selected delayed prompt", run: () => void steerSelected() },
    { bind: "ctrl+p", title: paused() ? "Resume delayed queue" : "Pause delayed queue", run: () => void togglePause() },
    { bind: "escape", title: "Close delayed prompts", run: () => props.context.ui.dialog.clear() },
  ]
  const navigation = () => [
    { bind: "up", title: "Previous delayed prompt", run: () => move(-1) },
    { bind: "down", title: "Next delayed prompt", run: () => move(1) },
    { bind: "return", title: "Steer selected delayed prompt", run: () => void steerSelected() },
  ]

  props.context.keymap.layer(() => ({
    mode: "modal",
    target: input,
    priority: 20,
    commands: [
      ...commands(),
      ...navigation(),
      { bind: "tab", title: "Focus delayed prompt list", run: () => scroll()?.focus() },
    ],
  }))
  props.context.keymap.layer(() => ({
    mode: "modal",
    target: scroll,
    priority: 20,
    commands: [
      ...commands(),
      ...navigation(),
      { bind: "tab", title: "Focus delayed prompt search", run: () => input()?.focus() },
    ],
  }))

  onMount(() => {
    props.context.ui.dialog.set({ size: "large", centered: true })
    focusTimer = setTimeout(() => input()?.focus(), 1)
  })
  onCleanup(() => {
    disposed = true
    if (focusTimer !== undefined) clearTimeout(focusTimer)
    focusTimer = undefined
  })

  return (
    <box paddingLeft={2} paddingRight={2} gap={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text attributes={TextAttributes.BOLD} fg={theme.text.base}>Delayed prompts</text>
        <text fg={theme.text.muted}>{`${items().length} queued${paused() ? " · paused" : ""}${busy() ? " · working" : ""}`}</text>
      </box>
      <Show when={paused()}>
        <box flexDirection="column" paddingLeft={1} paddingRight={1} backgroundColor={theme.background.raised.high}>
          <box flexDirection="row" gap={1}>
            <text attributes={TextAttributes.BOLD} fg={theme.text.feedback?.warning?.base ?? theme.text.muted}>⏸ Whole queue paused</text>
            <text fg={theme.text.muted}>{pauseReasonLabel(pauseReason())}</text>
          </box>
          <text fg={theme.text.muted}>
            {`${items().length} message${items().length === 1 ? "" : "s"} stay${items().length === 1 ? "s" : ""} queued · automatic delivery is off · ctrl+s still sends one now`}
          </text>
        </box>
      </Show>
      <input
        ref={setInput}
        value={query()}
        onInput={(value) => setQuery(value)}
        onSubmit={() => void steerSelected()}
        placeholder="Search delayed prompts..."
        placeholderColor={theme.text.muted}
        backgroundColor={theme.background?.formfield?.base ?? theme.background?.base}
        focusedBackgroundColor={theme.background?.formfield?.focused ?? theme.background?.raised?.high}
        textColor={theme.text.formfield.base}
        focusedTextColor={theme.text?.formfield?.focused ?? theme.text.formfield.base}
        cursorColor={theme.text.formfield.base}
      />
      <scrollbox ref={setScroll} focusable maxHeight={18} scrollbarOptions={{ visible: false }}>
        <Show
          when={filtered().length > 0}
          fallback={<text fg={theme.text.muted}>{query().trim() ? "No matching delayed prompts" : "No delayed prompts"}</text>}
        >
          <For each={filtered()}>
            {(item, index) => {
              const active = () => item.id === selected()
              return (
                <box
                  id={`delayed-queue-item-${item.id}`}
                  flexDirection="row"
                  paddingLeft={1}
                  paddingRight={1}
                  backgroundColor={active() ? theme.background.raised.high : undefined}
                  onMouseUp={() => setSelected(item.id)}
                >
                  <text fg={active() ? theme.text.base : theme.text.muted} flexGrow={1} flexShrink={1} minWidth={0} wrapMode="none" truncate>
                    {`${active() ? "▶ " : "  "}${item.text.replaceAll("\n", " ")}`}
                  </text>
                  <text fg={theme.text.muted}>{`${index() + 1} of ${filtered().length}`}</text>
                </box>
              )
            }}
          </For>
        </Show>
      </scrollbox>
      <box flexDirection="row" gap={2}>
        <text fg={theme.text.muted}>↑/↓ select</text>
        <text fg={theme.text.muted}>tab focus</text>
        <text fg={theme.text.muted} onMouseUp={() => void steerSelected()}>ctrl+s steer</text>
        <text fg={theme.text.muted} onMouseUp={() => void deleteSelected()}>ctrl+d delete</text>
        <text fg={theme.text.muted} onMouseUp={() => void togglePause()}>{`ctrl+p ${paused() ? "resume" : "pause"} queue`}</text>
        <text fg={theme.text.muted} onMouseUp={() => props.context.ui.dialog.clear()}>esc close</text>
      </box>
    </box>
  )
}

function pauseReasonLabel(reason: PauseReason | undefined) {
  switch (reason) {
    case "interrupted":
      return "after an interrupt"
    case "failed":
      return "after a failure"
    case "restart":
      return "after a restart"
    case "delivery":
      return "after delivery failures"
    case "manual":
      return "manually"
    default:
      return "no reason recorded"
  }
}

function describe(error: unknown, fallback: string) {
  const message = error instanceof Error ? error.message : String(error)
  if (!message || message === "undefined" || message === "null") return fallback
  return message
}
