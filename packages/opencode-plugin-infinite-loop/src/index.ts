import { Plugin } from "@opencode/plugin"
import type { Context } from "@opencode/plugin/promise/plugin"
import { InfiniteLoopController, isSessionBusy, type InfiniteLoopAbort } from "./controller.js"
import { MAX_COOLDOWN_MS, infiniteLoopEnabled, parseInfiniteLoopOptions, type InfiniteLoopOptions } from "./options.js"
import { InfiniteLoopRpc, toListItem, toStatusPayload } from "./rpc.js"
import { SessionTracker } from "./tracker.js"

type PluginContext = Pick<Context, "options" | "rpc" | "session" | "event" | "location">

type Runtime = {
  readonly controller: InfiniteLoopController
  readonly tracker: SessionTracker
  refs: number
  context: PluginContext
  contexts: PluginContext[]
  options: InfiniteLoopOptions
}

// OpenCode can load the same plugin module once per location. Keep the runtime on
// globalThis so every location instance observes the same tasks and session tree.
const RUNTIME_KEY = Symbol.for("max10240.infinite-loop.runtime")
const registry = globalThis as typeof globalThis & { [RUNTIME_KEY]?: Runtime }
let shared: Runtime | undefined = registry[RUNTIME_KEY]

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), timeoutMs)
  })
  return Promise.race([promise, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer)
  })
}

function createRuntime(context: PluginContext, options: InfiniteLoopOptions): Runtime {
  const tracker = new SessionTracker()
  const runtime = {} as Runtime
  const controller = new InfiniteLoopController({
    delayMs: options.delayMs,
    recheckMs: options.recheckMs,
    cooldownMs: options.cooldownMs,
    now: () => Date.now(),
    timers: { setTimeout, clearTimeout },
    isBusy: async (sessionID) => {
      const known = tracker.statusOf(sessionID)
      if (known !== undefined) return known === "running"
      try {
        // The tracker normally answers from memory. The fallback is bounded so a
        // stalled session read cannot leave a task without a timer.
        const info = await withTimeout(runtime.context.session.get({ sessionID }), 5_000)
        if (info === undefined) return true
        tracker.remember(info)
        return isSessionBusy(info)
      } catch {
        return true
      }
    },
    hasRunningWork: async (sessionID) => tracker.hasRunningWork(sessionID),
    send: async (sessionID) => {
      await runtime.context.session.prompt({
        sessionID,
        text: runtime.options.message,
        metadata: { infiniteLoop: true },
      })
    },
    onError: (error, sessionID) => {
      console.warn(`Infinite loop nudge failed for ${sessionID}: ${describe(error)}`)
    },
  })
  Object.assign(runtime, {
    controller,
    tracker,
    refs: 0,
    context,
    contexts: [],
    options,
  })
  shared = runtime
  registry[RUNTIME_KEY] = runtime
  return runtime
}

export async function setupInfiniteLoop(context: PluginContext) {
  let options: InfiniteLoopOptions
  try {
    options = parseInfiniteLoopOptions(context.options)
  } catch (error) {
    console.warn(`Infinite loop disabled: ${describe(error)}`)
    return async () => {}
  }
  if (!options.enabled || !infiniteLoopEnabled(context.options) || !context.rpc) return async () => {}
  if (typeof context.session?.hook !== "function") {
    console.warn("Infinite loop disabled: the running OpenCode does not expose the experimental.idle session hook")
    return async () => {}
  }

  const runtime = shared ?? registry[RUNTIME_KEY] ?? createRuntime(context, options)
  shared = runtime
  registry[RUNTIME_KEY] = runtime
  runtime.context = context
  if (!runtime.contexts.includes(context)) runtime.contexts.push(context)
  runtime.options = options
  runtime.refs += 1
  const tracker = runtime.tracker
  const controller = runtime.controller

  const idleHook = await context.session.hook("experimental.idle", (event) => {
    try {
      tracker.onIdle(event.sessionID, event.background)
      controller.onIdle(event.sessionID, event.background)
    } catch (error) {
      console.warn(`Infinite loop idle handling failed for ${event.sessionID}: ${describe(error)}`)
    }
  })
  const promptHook = await context.session.hook("prompt", (event) => {
    const own = isRecord(event.metadata) && event.metadata.infiniteLoop === true
    try {
      tracker.onPrompt(event.sessionID, own)
      controller.onPrompt(event.sessionID, own)
    } catch (error) {
      console.warn(`Infinite loop prompt handling failed for ${event.sessionID}: ${describe(error)}`)
    }
  })

  const aborts = new AbortController()
  if (typeof context.event?.subscribe === "function") {
    void watchEvents(context, aborts.signal, controller, tracker)
  }
  // The seed runs once at server startup. Later attaches reuse the live directory.
  void tracker.seed({ session: context.session })

  let registration: { dispose(): Promise<void> } | undefined
  try {
    registration = await context.rpc.register(InfiniteLoopRpc, {
      status: async (raw) => {
        const input = raw as { sessionID: string }
        return toStatusPayload(controller.status(input.sessionID))
      },
      list: async () => {
        const items = controller.activeStatuses().map(({ sessionID, status }) =>
          toListItem(sessionID, status, tracker.info(sessionID)),
        )
        items.sort((left, right) => {
          const directory = (left.directory ?? "").localeCompare(right.directory ?? "")
          if (directory !== 0) return directory
          return (left.title ?? left.sessionID).localeCompare(right.title ?? right.sessionID)
        })
        return items
      },
      start: async (raw, request) => {
        const input = raw as { sessionID: string; durationMs: number; cooldownMs?: number }
        if (typeof input.durationMs !== "number" || !Number.isFinite(input.durationMs) || input.durationMs <= 0) {
          return request.error("invalid", "durationMs must be a positive number of milliseconds", {})
        }
        if (
          input.cooldownMs !== undefined &&
          (typeof input.cooldownMs !== "number" || !Number.isFinite(input.cooldownMs) || input.cooldownMs < 0)
        ) {
          return request.error("invalid", "cooldownMs must be a non-negative number of milliseconds", {})
        }
        const cooldownMs = Math.min(
          Math.max(Math.round(input.cooldownMs ?? options.cooldownMs), 0),
          MAX_COOLDOWN_MS,
        )
        const durationMs = Math.min(
          Math.max(Math.round(input.durationMs), options.minDurationMs),
          options.maxDurationMs,
        )
        const known = tracker.statusOf(input.sessionID)
        let alreadyIdle: boolean
        if (known !== undefined) {
          alreadyIdle = known === "idle"
        } else {
          try {
            const info = await withTimeout(context.session.get({ sessionID: input.sessionID }), 5_000)
            if (info) tracker.remember(info)
            alreadyIdle = info !== undefined && !isSessionBusy(info)
          } catch {
            alreadyIdle = false
          }
        }
        return toStatusPayload(controller.start(input.sessionID, durationMs, alreadyIdle, cooldownMs))
      },
      stop: async (raw) => {
        const input = raw as { sessionID: string }
        return toStatusPayload(controller.stop(input.sessionID))
      },
    })
  } catch (error) {
    console.warn(`Infinite loop RPC unavailable: ${describe(error)}`)
  }

  return async () => {
    aborts.abort()
    await idleHook.dispose()
    await promptHook.dispose()
    if (registration) await registration.dispose()
    runtime.contexts = runtime.contexts.filter((item) => item !== context)
    if (runtime.context === context) runtime.context = runtime.contexts[0] ?? context
    runtime.refs -= 1
    if (runtime.refs <= 0) {
      controller.dispose()
      if (shared === runtime) shared = undefined
      if (registry[RUNTIME_KEY] === runtime) delete registry[RUNTIME_KEY]
    }
  }
}

async function watchEvents(
  context: PluginContext,
  signal: AbortSignal,
  controller: InfiniteLoopController,
  tracker: SessionTracker,
) {
  while (!signal.aborted) {
    try {
      for await (const event of context.event.subscribe({ signal })) {
        try {
          handleEvent(event, controller, tracker)
        } catch (error) {
          console.warn(`Infinite loop event handling failed: ${describe(error)}`)
        }
      }
    } catch {
      // The stream ends with the server or a transport error; reconnect until the plugin unloads.
    }
    if (signal.aborted) return
    await new Promise((resolve) => setTimeout(resolve, 1_000))
    // Reconcile deletions and status changes missed during the stream gap.
    void tracker.seed({ session: context.session }, 2_000, true)
  }
}

function handleEvent(
  event: { readonly type?: string; readonly created?: number; readonly location?: { readonly directory?: string }; readonly data?: unknown },
  controller: InfiniteLoopController,
  tracker: SessionTracker,
) {
  const type = event.type
  if (!type) return
  tracker.handle(event)
  const data = isRecord(event.data) ? event.data : {}
  const sessionID = typeof data.sessionID === "string" ? data.sessionID : undefined
  if (!sessionID) return

  if (type === "session.execution.failed") {
    controller.onAborted(sessionID, { type: "failed" })
    return
  }
  if (type === "session.execution.interrupted") {
    const reason = typeof data.reason === "string" ? data.reason : "shutdown"
    if (reason === "user") {
      // Pause the task if the interrupted session is the task or one of its descendants.
      let current: string | undefined = sessionID
      const seen = new Set<string>()
      while (current !== undefined && !seen.has(current)) {
        seen.add(current)
        if (controller.hasTask(current)) controller.onAborted(current, { type: "interrupted", reason: "user" })
        current = tracker.parentOf(current)
      }
      return
    }
    controller.onAborted(sessionID, { type: "interrupted", reason })
    return
  }
  if (type === "session.inbox.enqueued") {
    const own = ownInbox(event.data)
    tracker.onInboxEnqueued(sessionID, own)
    controller.onInboxEnqueued(sessionID, own)
    return
  }
  if (type === "session.inbox.cancelled") {
    tracker.onInboxCancelled(sessionID)
    controller.onInputCancelled(sessionID)
  }
}

function ownInbox(data: unknown): boolean {
  if (!isRecord(data)) return false
  const item = isRecord(data.item) ? data.item : undefined
  const payload = isRecord(item?.payload) ? item.payload : undefined
  const metadata = isRecord(payload?.metadata) ? payload.metadata : undefined
  return metadata?.infiniteLoop === true
}

export default Plugin.define({
  id: "max10240.infinite-loop",
  async setup(context) {
    return setupInfiniteLoop(context)
  },
})

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
