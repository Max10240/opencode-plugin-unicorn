import type { Context } from "@opencode/plugin/promise/plugin"

export type SessionStatus = "idle" | "running"

export interface OnlineSession {
  readonly id: string
  readonly title?: string
  readonly directory?: string
  readonly status: SessionStatus
  readonly createdAt: number
  readonly updatedAt: number
}

type EventContext = Pick<Context, "event">

type SessionRecord = {
  id: string
  title?: string
  directory?: string
  status: SessionStatus
  createdAt: number
  updatedAt: number
}

const sessions = new Map<string, SessionRecord>()
let watcher:
  | {
      readonly controller: AbortController
      references: number
    }
  | undefined

export function acquireSessionDirectory(context: EventContext): () => void {
  if (!watcher) {
    const controller = new AbortController()
    watcher = { controller, references: 0 }
    void watchEvents(context, controller.signal)
  }
  watcher.references += 1
  let released = false
  return () => {
    if (released) return
    released = true
    if (!watcher) return
    watcher.references -= 1
    if (watcher.references <= 0) {
      watcher.controller.abort()
      watcher = undefined
    }
  }
}

export function listOnlineSessions(excludeSessionID?: string): OnlineSession[] {
  return [...sessions.values()]
    .filter((session) => session.id !== excludeSessionID)
    .sort((left, right) => right.updatedAt - left.updatedAt)
}

async function watchEvents(context: EventContext, signal: AbortSignal) {
  try {
    for await (const event of context.event.subscribe({ signal })) {
      updateFromEvent(event as unknown as { type: string; created?: number; location?: { directory?: string }; data?: unknown })
    }
  } catch (error) {
    if (!signal.aborted) console.error("send-message-across-sessions: session event watcher stopped", error)
  }
}

function updateFromEvent(event: {
  readonly type: string
  readonly created?: number
  readonly location?: { readonly directory?: string }
  readonly data?: unknown
}) {
  const data = isRecord(event.data) ? event.data : {}
  const sessionID = typeof data.sessionID === "string" ? data.sessionID : undefined
  if (!sessionID) return
  const now = typeof event.created === "number" ? event.created : Date.now()
  const current = sessions.get(sessionID)

  if (event.type === "session.created") {
    const location = isRecord(data.location) ? data.location : undefined
    sessions.set(sessionID, {
      id: sessionID,
      title: typeof data.title === "string" ? data.title : undefined,
      directory:
        typeof location?.directory === "string" ? location.directory : event.location?.directory,
      status: "idle",
      createdAt: now,
      updatedAt: now,
    })
    return
  }

  if (event.type === "session.deleted") {
    sessions.delete(sessionID)
    return
  }

  const next: SessionRecord = {
    id: sessionID,
    title: current?.title,
    directory: current?.directory ?? event.location?.directory,
    status: current?.status ?? "idle",
    createdAt: current?.createdAt ?? now,
    updatedAt: now,
  }

  if (event.type === "session.execution.started") next.status = "running"
  if (
    event.type === "session.execution.succeeded" ||
    event.type === "session.execution.failed" ||
    event.type === "session.execution.interrupted"
  )
    next.status = "idle"
  if (event.type === "session.renamed" && typeof data.title === "string") next.title = data.title
  if (event.type === "session.moved") {
    const location = isRecord(data.location) ? data.location : undefined
    if (typeof location?.directory === "string") next.directory = location.directory
  }

  sessions.set(sessionID, next)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
