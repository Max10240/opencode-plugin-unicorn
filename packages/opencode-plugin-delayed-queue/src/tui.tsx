import { Plugin } from "@opencode/plugin/tui"
import type { Context } from "@opencode/plugin/tui/context"
import { createEffect, createMemo, createSignal, onCleanup, Show } from "solid-js"
import { parseDelayedQueueOptions, type DelayedQueueOptions } from "./options.js"
import { DelayedQueueRpc, type DelayedQueueStatusPayload } from "./rpc.js"

export const COMMAND_ID = "max10240.delayed-queue.open"
export const ENQUEUE_COMMAND_ID = "max10240.delayed-queue.enqueue"
export const SLASH_COMMAND = "delayed-queue"
export const SLASH_ALIASES = ["delay", "dq"] as const

const SPLIT_BORDER = {
  topLeft: "",
  bottomLeft: "",
  vertical: "┃",
  topRight: "",
  bottomRight: "",
  horizontal: " ",
  bottomT: "",
  topT: "",
  cross: "",
  leftT: "",
  rightT: "",
} as const

export default Plugin.define({
  id: "max10240.delayed-queue.tui",
  setup(context) {
    return setupDelayedQueueTui(context)
  },
})

export function setupDelayedQueueTui(context: Context) {
  let options: DelayedQueueOptions
  try {
    options = parseDelayedQueueOptions(context.options)
  } catch (error) {
    console.warn(`Delayed queue panel disabled: ${error instanceof Error ? error.message : "invalid options"}`)
    return
  }
  if (!options.enabled) return

  context.keymap.layer(() => ({
    mode: "global",
    priority: 10,
    commands: [
      {
        id: COMMAND_ID,
        title: "View delayed prompts",
        description: "Manage messages waiting for this session to become idle",
        group: "Prompt",
        bind: options.keybind === false ? false : options.keybind,
        palette: true,
        slash: { name: SLASH_COMMAND, aliases: [...SLASH_ALIASES], arguments: true },
        run: (input?: string) => {
          const route = context.ui.router.current()
          if (route.type !== "session") {
            context.ui.toast.show({ message: "Open a session first", variant: "warning" })
            return
          }
          const text = input?.trim()
          if (text) {
            void enqueue(context, route.sessionID, text)
            return
          }
          void openPanel(context, route.sessionID, options)
        },
      },
      {
        id: ENQUEUE_COMMAND_ID,
        title: "Queue delayed message",
        description: "Queue the current prompt to run after this session is idle and its background work finishes",
        group: "Prompt",
        bind: options.queueKeybind === false ? false : options.queueKeybind,
        palette: true,
        run: () => {
          const route = context.ui.router.current()
          if (route.type !== "session") {
            context.ui.toast.show({ message: "Open a session first", variant: "warning" })
            return
          }
          const composer = context.renderer.currentFocusedEditor
          const text =
            composer && typeof composer.plainText === "string" ? composer.plainText.trim() : ""
          if (text) {
            if (composer && typeof composer.setText === "function") composer.setText("")
            void enqueue(context, route.sessionID, text)
            return
          }
          void context.ui.dialog.prompt({ title: "Queue delayed message", placeholder: "Message" }).then((value) => {
            const message = value?.trim()
            if (message) void enqueue(context, route.sessionID, message)
          })
        },
      },
    ],
  }))

  const disposeSlot = context.ui.slot({
    append: "session.composer.top",
    render: (input) => <DelayedQueueDock context={context} sessionID={input.sessionID} options={options} />,
  })

  return () => {
    disposeSlot()
  }
}


type PluginLocation = ReturnType<Context["data"]["location"]["default"]>

function locationFor(context: Context, sessionID: string): PluginLocation {
  const session = context.data?.session?.get?.(sessionID) as { readonly location?: PluginLocation } | undefined
  if (session?.location) return session.location
  if (context.location) return context.location
  const fallback = context.data?.location?.default?.()
  return fallback ?? ({ directory: "/" } as PluginLocation)
}

export async function enqueue(context: Context, sessionID: string, text: string) {
  try {
    const state = (await context.client.rpc(DelayedQueueRpc).enqueue({
      sessionID,
      text,
      jobs: (await visibleJobs(context, sessionID)) as never,
    }, { location: locationFor(context, sessionID) })) as DelayedQueueStatusPayload
    // A normal enqueue is visible in the pending bar, so do not add a success toast.
    if (state.paused) {
      context.ui.toast.show({ message: "Delayed message queued · resume the queue to run it", variant: "warning" })
    }
  } catch (error) {
    context.ui.toast.show({ message: describe(error, "Could not queue the delayed message"), variant: "error" })
  }
}

export async function openPanel(context: Context, sessionID: string, options: DelayedQueueOptions): Promise<void> {
  let state: DelayedQueueStatusPayload
  try {
    state = (await context.client.rpc(DelayedQueueRpc).status({ sessionID }, { location: locationFor(context, sessionID) })) as DelayedQueueStatusPayload
  } catch (error) {
    context.ui.toast.show({ message: describe(error, "Delayed queue is unavailable"), variant: "error" })
    return
  }
  if (state.items.length === 0) {
    context.ui.toast.show({ message: "No delayed prompts", variant: "info" })
    return
  }

  const items = state.items
  let pendingDelete: string | undefined
  let deleteTimer: ReturnType<typeof setTimeout> | undefined
  const clearPendingDelete = () => {
    if (deleteTimer !== undefined) clearTimeout(deleteTimer)
    deleteTimer = undefined
    pendingDelete = undefined
  }
  const armPendingDelete = (id: string) => {
    clearPendingDelete()
    pendingDelete = id
    deleteTimer = setTimeout(() => {
      deleteTimer = undefined
      pendingDelete = undefined
    }, 3_000)
  }
  const result = await context.ui.dialog.select<string>({
    title: "Delayed prompts",
    placeholder: "Search",
    options: items.map((item, index) => ({
      title: item.text.replaceAll("\n", " "),
      value: item.id,
      footer: state.paused ? "paused" : `${index + 1} of ${items.length}`,
    })),
    search: (query, values) => {
      const needle = query.trim().toLowerCase()
      if (!needle) return values
      return values.filter((value) => value.title.toLowerCase().includes(needle))
    },
    actions: [
      {
        bind: "ctrl+s",
        title: "steer now",
        selection: "required",
        onTrigger: (value) => {
          clearPendingDelete()
          void deliver(context, sessionID, value)
        },
      },
      {
        bind: "ctrl+d",
        title: "delete",
        selection: "required",
        onTrigger: (value) => {
          if (pendingDelete !== value) {
            armPendingDelete(value)
            void context.ui.toast.show({ message: "Press ctrl+d again to delete", variant: "warning" })
            return
          }
          clearPendingDelete()
          void remove(context, sessionID, value, options)
        },
      },
      {
        bind: "ctrl+p",
        title: state.paused ? "resume" : "pause",
        selection: "none",
        onTrigger: () => {
          clearPendingDelete()
          void togglePause(context, sessionID, options, state.paused)
        },
      },
    ],
  })
  clearPendingDelete()

  if (result === undefined) return
  await deliver(context, sessionID, result)
}

async function deliver(context: Context, sessionID: string, id: string) {
  try {
    context.ui.dialog.clear()
    const state = (await context.client.rpc(DelayedQueueRpc).deliver({ sessionID, id }, { location: locationFor(context, sessionID) })) as DelayedQueueStatusPayload
    if (state.items.some((item) => item.id === id)) {
      context.ui.toast.show({ message: "Delayed prompt is still waiting", variant: "warning" })
    }
  } catch (error) {
    context.ui.toast.show({ message: describe(error, "Could not send the delayed prompt"), variant: "error" })
  }
}

async function remove(context: Context, sessionID: string, id: string, options: DelayedQueueOptions) {
  try {
    const state = (await context.client.rpc(DelayedQueueRpc).remove({ sessionID, ids: [id] }, { location: locationFor(context, sessionID) })) as DelayedQueueStatusPayload
    context.ui.dialog.clear()
    context.ui.toast.show({
      message: state.items.length === 0 ? "Delayed prompt deleted" : "Delayed prompt deleted",
      variant: "info",
    })
    if (state.items.length > 0) setTimeout(() => void openPanel(context, sessionID, options), 0)
  } catch (error) {
    context.ui.toast.show({ message: describe(error, "Could not delete the delayed prompt"), variant: "error" })
  }
}

async function togglePause(context: Context, sessionID: string, options: DelayedQueueOptions, paused: boolean) {
  try {
    if (paused) await context.client.rpc(DelayedQueueRpc).resume({ sessionID }, { location: locationFor(context, sessionID) })
    else await context.client.rpc(DelayedQueueRpc).pause({ sessionID }, { location: locationFor(context, sessionID) })
    context.ui.dialog.clear()
    context.ui.toast.show({ message: paused ? "Delayed queue resumed" : "Delayed queue paused", variant: "info" })
    setTimeout(() => void openPanel(context, sessionID, options), 0)
  } catch (error) {
    context.ui.toast.show({ message: describe(error, "Could not change the delayed queue"), variant: "error" })
  }
}

export function DelayedQueueDock(props: { context: Context; sessionID: string; options: DelayedQueueOptions }) {
  const theme = props.context.theme
  const [state, setState] = createSignal<DelayedQueueStatusPayload>()
  const [hover, setHover] = createSignal(false)
  const next = createMemo(() => state()?.items[0]?.text.replaceAll("\n", " "))
  const count = createMemo(() => state()?.items.length ?? 0)

  createEffect(() => {
    const sessionID = props.sessionID
    let active = true
    const rpc = props.context.client.rpc(DelayedQueueRpc)
    const apply = (value: DelayedQueueStatusPayload) => {
      if (active && value.sessionID === sessionID) setState(value)
    }
    const refresh = () => {
      const location = locationFor(props.context, sessionID)
      void visibleJobs(props.context, sessionID).then(async (jobs) => {
        const value =
          jobs === undefined
            ? await rpc.status({ sessionID }, { location })
            : await rpc.syncJobs({ sessionID, jobs: jobs as never }, { location })
        apply(value as DelayedQueueStatusPayload)
      }, () => {})
    }
    refresh()
    const timer = setInterval(refresh, 1_000)
    const stop = rpc.events.on("changed", (event) => {
      const data = event.data as { sessionID: string; state: DelayedQueueStatusPayload }
      if (data.sessionID === sessionID) apply(data.state)
    })
    onCleanup(() => {
      active = false
      clearInterval(timer)
      stop()
    })
  })

  return (
    <Show when={count() > 0}>
      <box
        marginBottom={1}
        border={["left"]}
        borderColor={theme.border.base}
        customBorderChars={SPLIT_BORDER}
        onMouseOver={() => setHover(true)}
        onMouseOut={() => setHover(false)}
        onMouseUp={() => void openPanel(props.context, props.sessionID, props.options)}
      >
        <box
          width="100%"
          paddingTop={1}
          paddingBottom={1}
          paddingLeft={2}
          paddingRight={2}
          backgroundColor={hover() ? theme.decrease(theme.background.raised.base) : theme.background.raised.base}
          flexDirection="row"
        >
          <text fg={theme.text.muted} wrapMode="none" truncate flexGrow={1} flexShrink={1} minWidth={0}>
            <span style={{ fg: theme.text.base }}>{count()} delayed</span>
            <Show when={next()}>{(text) => <> · {text()}</>}</Show>
            <Show when={state()?.paused}> · paused</Show>
          </text>
        </box>
      </box>
    </Show>
  )
}

async function visibleJobs(context: Context, sessionID: string) {
  try {
    const jobs = await context.client.experimental.job.list({
      sessionID,
      descendants: true,
      status: "running",
    })
    return jobs.map((job) => {
      const base = { id: job.id, kind: job.kind, sessionID: job.sessionID, status: job.status }
      if (job.kind === "shell") return { ...base, shellID: job.shellID, command: job.command, title: job.title }
      if (job.kind === "subagent")
        return {
          ...base,
          childSessionID: job.childSessionID,
          description: job.description,
          title: job.title,
        }
      if (job.kind === "image") return { ...base, path: job.path, title: job.title }
      return base
    })
  } catch {
    return undefined
  }
}

function describe(error: unknown, fallback: string) {
  const message = error instanceof Error ? error.message : String(error)
  if (!message || message === "undefined" || message === "null") return fallback
  return message
}
