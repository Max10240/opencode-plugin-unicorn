import { TextAttributes } from "@opentui/core"
import { Plugin } from "@opencode/plugin/tui"
import type { Context } from "@opencode/plugin/tui/context"
import { createEffect, createMemo, createSignal, onCleanup, Show } from "solid-js"
import { parseDelayedQueueOptions, type DelayedQueueOptions } from "./options.js"
import { DelayedQueuePanel } from "./panel.js"
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
          void openPanel(context, route.sessionID)
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

export async function openPanel(context: Context, sessionID: string): Promise<void> {
  const location = locationFor(context, sessionID)
  let state: DelayedQueueStatusPayload
  try {
    state = (await context.client.rpc(DelayedQueueRpc).status({ sessionID }, { location })) as DelayedQueueStatusPayload
  } catch (error) {
    context.ui.toast.show({ message: describe(error, "Delayed queue is unavailable"), variant: "error" })
    return
  }
  if (state.items.length === 0) {
    context.ui.toast.show({ message: "No delayed prompts", variant: "info" })
    return
  }
  context.ui.dialog.show(() => (
    <DelayedQueuePanel context={context} sessionID={sessionID} initial={state} location={location} />
  ))
}

export function DelayedQueueDock(props: { context: Context; sessionID: string; options: DelayedQueueOptions }) {
  const theme = props.context.theme
  const [state, setState] = createSignal<DelayedQueueStatusPayload>()
  const [hover, setHover] = createSignal(false)
  const next = createMemo(() => state()?.items[0]?.text.replaceAll("\n", " "))
  const count = createMemo(() => state()?.items.length ?? 0)
  const paused = createMemo(() => state()?.paused === true)
  const warning = () => theme.text.feedback?.warning?.base ?? theme.text.muted

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
        borderColor={paused() ? warning() : theme.border.base}
        customBorderChars={SPLIT_BORDER}
        onMouseOver={() => setHover(true)}
        onMouseOut={() => setHover(false)}
        onMouseUp={() => void openPanel(props.context, props.sessionID)}
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
            <Show
              when={paused()}
              fallback={
                <>
                  <span style={{ fg: theme.text.base }}>{count()} delayed</span>
                  <Show when={next()}>{(text) => <> · {text()}</>}</Show>
                </>
              }
            >
              <span style={{ fg: warning(), attributes: TextAttributes.BOLD }}>
                {`⏸ ${count()} delayed · ${dockPauseLabel(state()?.pauseReason)}`}
              </span>
              <Show when={next()}>{(text) => <span style={{ fg: theme.text.muted }}> · {text()}</span>}</Show>
            </Show>
          </text>
        </box>
      </box>
    </Show>
  )
}

function dockPauseLabel(reason: DelayedQueueStatusPayload["pauseReason"]) {
  switch (reason) {
    case "interrupted":
      return "paused after interrupt"
    case "failed":
      return "paused after failure"
    case "restart":
      return "paused after restart"
    case "delivery":
      return "paused after delivery failures"
    default:
      return "paused"
  }
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
