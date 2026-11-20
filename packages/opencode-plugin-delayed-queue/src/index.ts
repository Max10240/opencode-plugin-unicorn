import { Plugin } from "@opencode/plugin"
import type { Context } from "@opencode/plugin/promise/plugin"
import { DelayedQueueController, type DelayedQueueBackground, type DelayedQueueJob, type PersistedDelayedQueue } from "./controller.js"
import { delayedQueueEnabled, parseDelayedQueueOptions, type DelayedQueueOptions } from "./options.js"
import { DelayedQueueRpc, toJobPayload, toStatusPayload } from "./rpc.js"

const STORAGE_PREFIX = "state:"
const MAX_SCAN_PAGES = 100
let processBoot: string | undefined
const boot = () => (processBoot ??= crypto.randomUUID())

type PluginContext = Pick<Context, "session" | "storage" | "event" | "rpc" | "options">

type IdleWork = {
  readonly kind: string
  readonly sessionID: string
  readonly jobID?: string
  readonly shellID?: string
  readonly command?: string
  readonly childSessionID?: string
  readonly agent?: string
  readonly description?: string
  readonly path?: string
  readonly model?: string
}

type RpcStatusInput = { readonly sessionID: string }
type RpcEnqueueInput = {
  readonly sessionID: string
  readonly text: string
  readonly jobs?: readonly DelayedQueueJob[]
}
type RpcRemoveInput = { readonly sessionID: string; readonly ids: readonly string[] }
type RpcSyncJobsInput = { readonly sessionID: string; readonly jobs: readonly DelayedQueueJob[] }
type RpcDeliverInput = { readonly sessionID: string; readonly id: string }

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export async function setupDelayedQueue(context: PluginContext) {
  let options: DelayedQueueOptions
  try {
    options = parseDelayedQueueOptions(context.options)
  } catch (error) {
    console.warn(`Delayed queue disabled: ${describe(error)}`)
    return async () => {}
  }
  if (!options.enabled || !delayedQueueEnabled(context.options) || !context.rpc) return async () => {}
  if (typeof context.session?.hook !== "function") {
    console.warn("Delayed queue disabled: the running OpenCode does not expose session hooks")
    return async () => {}
  }

  let emitChanged: (sessionID: string, status: ReturnType<DelayedQueueController["status"]>) => void = () => {}
  const controller = new DelayedQueueController({
    boot: boot(),
    recheckMs: options.recheckMs,
    waitKinds: options.waitKinds,
    waitDescendants: options.waitDescendants,
    pauseOnInterrupt: options.pauseOnInterrupt,
    pauseOnFailure: options.pauseOnFailure,
    now: () => Date.now(),
    isBusy: async (sessionID) => isSessionBusy(await context.session.get({ sessionID })),
    parentOf: async (sessionID) => (await context.session.get({ sessionID })).parentID,
    deliver: async (sessionID, item) => {
      await context.session.prompt({
        sessionID,
        id: item.id as Parameters<Context["session"]["prompt"]>[0]["id"],
        text: item.text,
        metadata: { delayedQueue: true, queueID: item.id },
      })
    },
    save: (sessionID, state) => context.storage.set(storageKey(sessionID), storageValue(state)),
    onChange: (status) => emitChanged(status.sessionID, status),
    onError: (error, sessionID) => console.warn(`Delayed queue failed for ${sessionID}: ${describe(error)}`),
  })

  const loaded = await loadStored(context, controller).catch((error) => {
    console.warn(`Delayed queue could not load persisted messages: ${describe(error)}`)
    return 0
  })

  const idleHook = await context.session.hook("experimental.idle", (event) => {
    const background = event.background.map(toBackground)
    void controller.onIdle(event.sessionID, background)
  })
  const promptHook = await context.session.hook("prompt", (event) => {
    const own = isRecord(event.metadata) && event.metadata.delayedQueue === true
    void controller.onPrompt(event.sessionID, own)
  })

  const registration = await context.rpc.register(DelayedQueueRpc, {
    status: async (input) => {
      const value = input as RpcStatusInput
      return toStatusPayload(controller.status(value.sessionID))
    },
    enqueue: async (input) => {
      const value = input as RpcEnqueueInput
      return toStatusPayload(await controller.enqueue(value.sessionID, value.text, value.jobs?.map(toJobPayload)))
    },
    syncJobs: async (input) => {
      const value = input as RpcSyncJobsInput
      return toStatusPayload(await controller.syncJobs(value.sessionID, value.jobs.map(toJobPayload)))
    },
    remove: async (input) => {
      const value = input as RpcRemoveInput
      return toStatusPayload(await controller.remove(value.sessionID, value.ids))
    },
    clear: async (input) => {
      const value = input as RpcStatusInput
      return toStatusPayload(await controller.clear(value.sessionID))
    },
    pause: async (input) => {
      const value = input as RpcStatusInput
      return toStatusPayload(await controller.pause(value.sessionID, "manual"))
    },
    resume: async (input) => {
      const value = input as RpcStatusInput
      return toStatusPayload(await controller.resume(value.sessionID))
    },
    deliver: async (input) => {
      const value = input as RpcDeliverInput
      return toStatusPayload(await controller.deliverNow(value.sessionID, value.id))
    },
  })
  emitChanged = (sessionID, status) => {
    void registration.events.emit("changed", { sessionID, state: toStatusPayload(status) }).catch((error) => {
      console.warn(`Delayed queue could not publish a change: ${describe(error)}`)
    })
  }

  const abort = new AbortController()
  void watchEvents(context, controller, abort.signal)
  if (loaded > 0) console.info(`Delayed queue restored ${loaded} session(s)`)

  return async () => {
    abort.abort()
    controller.dispose()
    await idleHook.dispose()
    await promptHook.dispose()
    await registration.dispose()
  }
}

export default Plugin.define({
  id: "max10240.delayed-queue",
  async setup(context) {
    return setupDelayedQueue(context)
  },
})

function isSessionBusy(info: { readonly time?: { readonly busy?: number; readonly idle?: number } } | undefined | null) {
  const busy = info?.time?.busy
  if (busy === undefined) return false
  const idle = info?.time?.idle
  if (idle === undefined) return true
  return busy > idle
}

function storageKey(sessionID: string): string {
  return STORAGE_PREFIX + sessionID
}

function storageValue(state: PersistedDelayedQueue) {
  return {
    version: state.version,
    boot: state.boot,
    paused: state.paused,
    ...(state.pauseReason === undefined ? {} : { pauseReason: state.pauseReason }),
    items: state.items.map((item) => ({ id: item.id, text: item.text, createdAt: item.createdAt })),
    updatedAt: state.updatedAt,
  }
}

async function loadStored(context: PluginContext, controller: DelayedQueueController): Promise<number> {
  let after: string | undefined
  const seen = new Set<string>()
  let loaded = 0
  for (let pageIndex = 0; pageIndex < MAX_SCAN_PAGES; pageIndex++) {
    const page = await context.storage.scan({
      prefix: STORAGE_PREFIX,
      limit: 100,
      ...(after === undefined ? {} : { after }),
    })
    for (const entry of page.entries) {
      const state = decodeState(entry.value)
      if (!state) continue
      const sessionID = entry.key.slice(STORAGE_PREFIX.length)
      if (!sessionID) continue
      try {
        await context.session.get({ sessionID: sessionID as never })
      } catch (error) {
        console.warn(`Delayed queue skipped a missing session ${sessionID}: ${describe(error)}`)
        continue
      }
      controller.hydrate(sessionID, state)
      loaded++
    }
    const next = page.next === undefined || page.next === "" ? undefined : page.next
    if (!next || next === after || seen.has(next) || page.entries.length === 0) break
    seen.add(next)
    after = next
  }
  return loaded
}

function decodeState(value: unknown): PersistedDelayedQueue | undefined {
  if (!isRecord(value) || value.version !== 1) return undefined
  if (typeof value.boot !== "string" || !Array.isArray(value.items)) return undefined
  if (typeof value.updatedAt !== "number") return undefined
  const items = value.items.flatMap((entry) => {
    if (!isRecord(entry)) return []
    if (typeof entry.id !== "string" || typeof entry.text !== "string" || typeof entry.createdAt !== "number") return []
    if (!entry.id.startsWith("msg_") || !entry.text.trim()) return []
    return [{ id: entry.id, text: entry.text, createdAt: entry.createdAt }]
  })
  return {
    version: 1,
    boot: value.boot,
    paused: value.paused === true,
    ...(isPauseReason(value.pauseReason) ? { pauseReason: value.pauseReason } : {}),
    items,
    updatedAt: value.updatedAt,
  }
}

function isPauseReason(value: unknown): value is PersistedDelayedQueue["pauseReason"] {
  return value === "interrupted" || value === "failed" || value === "restart" || value === "manual" || value === "delivery"
}

async function watchEvents(
  context: PluginContext,
  controller: DelayedQueueController,
  signal: AbortSignal,
): Promise<void> {
  try {
    for await (const event of context.event.subscribe({ signal })) {
      const data = (isRecord(event.data) ? event.data : {}) as Record<string, unknown>
      const type = event.type as string
      const sessionID = typeof data.sessionID === "string" ? data.sessionID : undefined
      if (type === "experimental.job.updated") {
        const info = isRecord(data.info) ? data.info : undefined
        const job = info ? toJob(info) : undefined
        if (job) controller.onJob(job)
        continue
      }
      if (!sessionID) continue
      if (type === "session.execution.started") {
        controller.onExecutionStarted(sessionID)
        continue
      }
      if (type === "session.execution.failed") {
        void controller.onExecutionFailed(sessionID)
        continue
      }
      if (type === "session.execution.interrupted") {
        void controller.onExecutionInterrupted(sessionID, typeof data.reason === "string" ? data.reason : "")
        continue
      }
      if (type === "session.deleted") {
        void controller.onSessionDeleted(sessionID).then(() => context.storage.remove(storageKey(sessionID)))
      }
    }
  } catch (error) {
    if (!signal.aborted) console.warn(`Delayed queue event stream failed: ${describe(error)}`)
  }
}

function toBackground(work: IdleWork): DelayedQueueBackground {
  if (work.kind === "shell") {
    return {
      kind: work.kind,
      sessionID: work.sessionID,
      shellID: work.shellID ?? "",
      command: work.command ?? "",
      label: work.command ?? "",
    }
  }
  if (work.kind === "subagent") {
    return {
      kind: work.kind,
      sessionID: work.sessionID,
      childSessionID: work.childSessionID ?? "",
      agent: work.agent ?? "",
      description: work.description ?? "",
      label: work.description ?? "",
    }
  }
  if (work.kind === "image") {
    return { kind: work.kind, sessionID: work.sessionID, path: work.path ?? "", model: work.model ?? "", label: work.path }
  }
  if (work.kind === "video") return { kind: work.kind, sessionID: work.sessionID, path: work.path ?? "", label: work.path }
  return { kind: work.kind, sessionID: work.sessionID, jobID: work.jobID ?? "", label: "Code Mode script" }
}

function toJob(info: Record<string, unknown>): DelayedQueueJob | undefined {
  if (typeof info.id !== "string" || typeof info.kind !== "string" || typeof info.sessionID !== "string") return undefined
  return {
    id: info.id,
    kind: info.kind,
    sessionID: info.sessionID,
    status: typeof info.status === "string" ? info.status : "running",
    ...(typeof info.childSessionID === "string" ? { childSessionID: info.childSessionID } : {}),
    ...(typeof info.shellID === "string" ? { shellID: info.shellID } : {}),
    ...(typeof info.command === "string" ? { command: info.command } : {}),
    ...(typeof info.description === "string" ? { description: info.description } : {}),
    ...(typeof info.title === "string" ? { title: info.title } : {}),
    ...(typeof info.path === "string" ? { path: info.path } : {}),
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
