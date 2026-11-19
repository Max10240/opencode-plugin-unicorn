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

type EventContext = Pick<Context, "event" | "storage">
type StorageContext = Pick<Context, "storage"> & {
  readonly session?: Pick<Context["session"], "list">
}

type SessionRecord = {
  id: string
  title?: string
  directory?: string
  status: SessionStatus
  createdAt: number
  updatedAt: number
}

const sessions = new Map<string, SessionRecord>()
const SESSION_STORAGE_PREFIX = "online-sessions/"
const LIST_SCAN_TIMEOUT_MS = 2_000
const MAX_SCAN_PAGES = 1_000
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

export async function listOnlineSessionsAcrossContexts(
  context: StorageContext,
  excludeSessionID?: string,
  timeoutMs = LIST_SCAN_TIMEOUT_MS,
): Promise<OnlineSession[]> {
  const authoritative = await withTimeout(listFromSessionApi(context), timeoutMs).catch(() => undefined)
  if (authoritative !== undefined) {
    const live = new Set(authoritative.map((session) => session.id))
    void withTimeout(pruneStoredSessions(context, live), timeoutMs).catch(() => {})
    return authoritative
      .filter((session) => session.id !== excludeSessionID)
      .sort((left, right) => right.updatedAt - left.updatedAt)
  }

  const all = new Map(sessions)
  if (typeof context.storage?.scan === "function") {
    await withTimeout(scanStoredSessions(context, all), timeoutMs).catch(() => undefined)
  }

  return [...all.values()]
    .filter((session) => session.id !== excludeSessionID)
    .sort((left, right) => right.updatedAt - left.updatedAt)
}

async function listFromSessionApi(context: StorageContext): Promise<SessionRecord[] | undefined> {
  const list = context.session?.list
  if (typeof list !== "function") return undefined
  const result: SessionRecord[] = []
  let cursor: string | undefined
  for (let pageIndex = 0; pageIndex < MAX_SCAN_PAGES; pageIndex++) {
    const page = await list({
      limit: 200,
      order: "desc",
      archived: false,
      ...(cursor === undefined ? {} : { cursor }),
    })
    if (!page || !Array.isArray(page.data)) return undefined
    for (const info of page.data) {
      const record = recordFromInfo(info)
      if (record) result.push(record)
    }
    const next = page.cursor?.next
    if (!next) break
    cursor = next as string
  }
  return result
}

function recordFromInfo(info: {
  readonly id: string
  readonly title?: string
  readonly location?: { readonly directory?: string }
  readonly time?: { readonly created?: number; readonly updated?: number; readonly busy?: number; readonly idle?: number }
}): SessionRecord | undefined {
  if (!info || typeof info.id !== "string" || !info.time) return undefined
  const created = Number(info.time.created)
  const updated = Number(info.time.updated)
  if (!Number.isFinite(created) || !Number.isFinite(updated)) return undefined
  const busy = info.time.busy
  const idle = info.time.idle
  return {
    id: info.id,
    title: info.title,
    directory: info.location?.directory,
    status: busy !== undefined && (idle === undefined || busy > idle) ? "running" : "idle",
    createdAt: created,
    updatedAt: updated,
  }
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

async function pruneStoredSessions(context: StorageContext, live: ReadonlySet<string>) {
  if (typeof context.storage?.scan !== "function") return
  let after: string | undefined
  const seen = new Set<string>()
  for (let pageIndex = 0; pageIndex < MAX_SCAN_PAGES; pageIndex++) {
    const page = await context.storage.scan({
      prefix: SESSION_STORAGE_PREFIX,
      limit: 200,
      ...(after === undefined ? {} : { after }),
    })
    if (!page || !Array.isArray(page.entries)) return
    for (const entry of page.entries) {
      if (!isSessionRecord(entry.value) || live.has(entry.value.id)) continue
      sessions.delete(entry.value.id)
      try { await context.storage.remove(entry.key) } catch {}
    }
    const next = typeof page.next === "string" && page.next ? page.next : undefined
    if (!next || next === after || seen.has(next) || page.entries.length === 0) return
    seen.add(next)
    after = next
  }
}

async function scanStoredSessions(context: StorageContext, all: Map<string, SessionRecord>) {
  let after: string | undefined
  const seen = new Set<string>()
  for (let pageIndex = 0; pageIndex < MAX_SCAN_PAGES; pageIndex++) {
    const page = await context.storage.scan({
      prefix: SESSION_STORAGE_PREFIX,
      limit: 200,
      ...(after === undefined ? {} : { after }),
    })
    if (!page || !Array.isArray(page.entries)) return
    for (const entry of page.entries) {
      if (!isSessionRecord(entry.value)) continue
      const current = all.get(entry.value.id)
      if (!current || entry.value.updatedAt >= current.updatedAt) all.set(entry.value.id, entry.value)
    }
    const next = typeof page.next === "string" && page.next ? page.next : undefined
    if (!next || next === after || seen.has(next) || page.entries.length === 0) return
    seen.add(next)
    after = next
  }
}

async function watchEvents(context: EventContext, signal: AbortSignal) {
  try {
    for await (const event of context.event.subscribe({ signal })) {
      const typedEvent = event as unknown as {
        type: string
        created?: number
        location?: { directory?: string }
        data?: unknown
      }
      const updated = updateFromEvent(typedEvent)
      if (!updated) continue

      try {
        if (typedEvent.type === "session.deleted") {
          await context.storage.remove(sessionStorageKey(updated.id))
        } else if (isSessionDirectoryEvent(typedEvent.type)) {
          await context.storage.set(sessionStorageKey(updated.id), toStorageRecord(updated))
        }
      } catch {
        // Keep the in-memory directory live when durable storage fails.
      }
    }
  } catch {}
}

function updateFromEvent(event: {
  readonly type: string
  readonly created?: number
  readonly location?: { readonly directory?: string }
  readonly data?: unknown
}): SessionRecord | undefined {
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
    return sessions.get(sessionID)
  }

  if (event.type === "session.deleted") {
    sessions.delete(sessionID)
    return { id: sessionID, status: "idle", createdAt: now, updatedAt: now }
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
  return next
}

function isSessionDirectoryEvent(type: string) {
  return (
    type === "session.created" ||
    type === "session.viewed" ||
    type === "session.renamed" ||
    type === "session.moved" ||
    type === "session.execution.started" ||
    type === "session.execution.succeeded" ||
    type === "session.execution.failed" ||
    type === "session.execution.interrupted"
  )
}

function sessionStorageKey(sessionID: string) {
  return `${SESSION_STORAGE_PREFIX}${encodeURIComponent(sessionID)}`
}

function toStorageRecord(session: SessionRecord) {
  return Object.fromEntries(Object.entries(session).filter(([, value]) => value !== undefined)) as Parameters<
    Context["storage"]["set"]
  >[1]
}

function isSessionRecord(value: unknown): value is SessionRecord {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    (value.status === "idle" || value.status === "running") &&
    typeof value.createdAt === "number" &&
    typeof value.updatedAt === "number" &&
    (value.title === undefined || typeof value.title === "string") &&
    (value.directory === undefined || typeof value.directory === "string")
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
