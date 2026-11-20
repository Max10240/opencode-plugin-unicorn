import { isSessionBusy } from "./controller.js"

type SessionListInfo = {
  readonly id: string
  readonly parentID?: string
  readonly title?: string
  readonly location?: { readonly directory?: string }
  readonly time?: { readonly created?: number; readonly updated?: number; readonly busy?: number; readonly idle?: number }
}

type SessionListPage = {
  readonly data?: readonly SessionListInfo[]
  readonly cursor?: { readonly next?: string | null }
}

type SessionList = (input?: {
  readonly limit?: number
  readonly order?: "asc" | "desc"
  readonly archived?: boolean
  readonly cursor?: string
}) => Promise<SessionListPage>

export type TrackerContext = {
  readonly session?: {
    readonly list?: SessionList
  }
}

export type TrackerInfo = {
  id: string
  parentID?: string
  title?: string
  directory?: string
  status: "idle" | "running"
  pending: boolean
  createdAt: number
  updatedAt: number
}

export type TrackerBackground = {
  readonly sessionID: string
  readonly kind: string
  readonly shellID?: string
  readonly path?: string
}

type ShellRecord = {
  readonly owner: string
  readonly root: string
}

type ImageRecord = {
  readonly owner: string
}

const MAX_SEED_PAGES = 20
const SEED_PAGE_SIZE = 200

/**
 * Event-maintained session tree. It keeps the loop's hot path free of database reads:
 * startup seeds once, then session/shell/execution events keep the snapshot current.
 */
export class SessionTracker {
  private readonly records = new Map<string, TrackerInfo>()
  private readonly children = new Map<string, Set<string>>()
  private readonly shells = new Map<string, ShellRecord>()
  private readonly images = new Map<string, ImageRecord>()
  private seeded = false
  private seeding: Promise<void> | undefined

  async seed(context: TrackerContext, timeoutMs = 2_000, force = false): Promise<void> {
    if (this.seeding) return this.seeding
    if (this.seeded && !force) return
    const started = Date.now()
    this.seeding = (async () => {
      const list = context.session?.list
      if (typeof list !== "function") return
      try {
        const infos = await withTimeout(listAll(list), timeoutMs)
        if (infos === undefined) return
        const live = new Set<string>()
        for (const info of infos) {
          live.add(info.id)
          this.upsert(info)
        }
        // A reconnect can miss deletion events. Remove records that were not in the
        // snapshot and were already old when the snapshot started; sessions created
        // while the seed was in flight stay.
        for (const record of [...this.records.values()]) {
          if (live.has(record.id) || record.updatedAt >= started) continue
          this.remove(record.id)
        }
        this.seeded = true
      } catch {
        // Events keep the tree live even when the initial seed is unavailable.
      } finally {
        this.seeding = undefined
      }
    })()
    return this.seeding
  }

  handle(event: { readonly type?: string; readonly created?: number; readonly location?: { readonly directory?: string }; readonly data?: unknown }): void {
    const type = event.type
    const data = isRecord(event.data) ? event.data : {}
    if (type === "shell.created") {
      const info = isRecord(data.info) ? data.info : undefined
      if (info?.status !== "running" || typeof info.id !== "string") return
      const metadata = isRecord(info.metadata) ? info.metadata : undefined
      const owner = typeof metadata?.sessionID === "string" ? metadata.sessionID : undefined
      if (!owner) return
      this.shells.set(info.id, { owner, root: this.rootOf(owner) })
      return
    }
    if (type === "shell.exited" || type === "shell.deleted") {
      if (typeof data.id === "string") this.shells.delete(data.id)
      return
    }
    const sessionID = typeof data.sessionID === "string" ? data.sessionID : undefined
    if (!sessionID) return
    const now = typeof event.created === "number" ? event.created : Date.now()
    if (type === "session.created") {
      const location = isRecord(data.location) ? data.location : undefined
      this.upsert({
        id: sessionID,
        parentID: typeof data.parentID === "string" ? data.parentID : undefined,
        title: typeof data.title === "string" ? data.title : undefined,
        location: {
          directory:
            typeof location?.directory === "string" ? location.directory : event.location?.directory,
        },
        time: { created: now, updated: now },
      })
      return
    }
    if (type === "session.deleted") {
      this.remove(sessionID)
      return
    }
    if (type === "session.renamed") {
      const record = this.ensure(sessionID, now)
      if (typeof data.title === "string") record.title = data.title
      record.updatedAt = now
      return
    }
    if (type === "session.moved") {
      const record = this.ensure(sessionID, now)
      const location = isRecord(data.location) ? data.location : undefined
      if (typeof location?.directory === "string") record.directory = location.directory
      record.updatedAt = now
      return
    }
    if (type === "session.execution.started") {
      this.onExecutionStarted(sessionID, now)
      return
    }
    if (
      type === "session.execution.succeeded" ||
      type === "session.execution.failed" ||
      type === "session.execution.interrupted"
    ) {
      this.onExecutionEnded(sessionID, now)
    }
  }

  onPrompt(sessionID: string, own: boolean, now = Date.now()): void {
    if (own) return
    const record = this.ensure(sessionID, now)
    record.pending = true
    record.updatedAt = now
  }

  onInboxEnqueued(sessionID: string, own: boolean, now = Date.now()): void {
    if (own) return
    const record = this.ensure(sessionID, now)
    record.pending = true
    record.updatedAt = now
  }

  onInboxCancelled(sessionID: string, now = Date.now()): void {
    const record = this.records.get(sessionID)
    if (!record) return
    record.pending = false
    record.updatedAt = now
  }

  onExecutionStarted(sessionID: string, now = Date.now()): void {
    const record = this.ensure(sessionID, now)
    record.status = "running"
    record.pending = false
    record.updatedAt = now
  }

  onExecutionEnded(sessionID: string, now = Date.now()): void {
    const record = this.ensure(sessionID, now)
    record.status = "idle"
    record.pending = false
    record.updatedAt = now
  }

  onIdle(sessionID: string, background: readonly TrackerBackground[], now = Date.now()): void {
    const record = this.ensure(sessionID, now)
    record.status = "idle"
    record.pending = false
    record.updatedAt = now
    const keepShells = new Set<string>()
    const keepImages = new Set<string>()
    for (const work of background) {
      if (typeof work.sessionID !== "string") continue
      if (work.sessionID !== sessionID) {
        const child = this.ensure(work.sessionID, now)
        if (child.parentID === undefined) {
          child.parentID = sessionID
          this.indexChild(sessionID, work.sessionID)
        }
        if (work.kind === "subagent") child.status = "running"
      }
      if (work.kind === "shell" && typeof work.shellID === "string") {
        this.shells.set(work.shellID, { owner: work.sessionID, root: this.rootOf(work.sessionID) })
        if (work.sessionID === sessionID) keepShells.add(work.shellID)
      }
      if (work.kind === "image" && typeof work.path === "string") {
        const key = imageKey(work.sessionID, work.path)
        this.images.set(key, { owner: work.sessionID })
        if (work.sessionID === sessionID) keepImages.add(key)
      }
    }
    // Reconcile only this session's own work. A descendant's execution events and idle
    // hook own its status, so a parent snapshot never clears a still-running child.
    for (const [id, shell] of this.shells) {
      if (shell.owner === sessionID && !keepShells.has(id)) this.shells.delete(id)
    }
    for (const [key, image] of this.images) {
      if (image.owner === sessionID && !keepImages.has(key)) this.images.delete(key)
    }
  }

  /** Merge a session row fetched outside the event stream. */
  remember(info: SessionListInfo): void {
    this.upsert(info)
  }

  statusOf(sessionID: string): "idle" | "running" | undefined {
    const record = this.records.get(sessionID)
    if (!record) return undefined
    return record.status === "running" || record.pending ? "running" : "idle"
  }

  isBusy(sessionID: string): boolean {
    return this.statusOf(sessionID) === "running"
  }

  info(sessionID: string): { title?: string; directory?: string } {
    const record = this.records.get(sessionID)
    if (!record) return {}
    return {
      ...(record.title === undefined ? {} : { title: record.title }),
      ...(record.directory === undefined ? {} : { directory: record.directory }),
    }
  }

  parentOf(sessionID: string): string | undefined {
    return this.records.get(sessionID)?.parentID
  }

  rootOf(sessionID: string): string {
    let current = sessionID
    const seen = new Set<string>()
    for (;;) {
      if (seen.has(current)) return current
      seen.add(current)
      const parent = this.records.get(current)?.parentID
      if (parent === undefined) return current
      current = parent
    }
  }

  family(sessionID: string): Set<string> {
    const family = new Set<string>([sessionID])
    const stack = [sessionID]
    while (stack.length > 0) {
      const current = stack.pop()
      if (current === undefined) continue
      for (const child of this.children.get(current) ?? []) {
        if (family.has(child)) continue
        family.add(child)
        stack.push(child)
      }
    }
    return family
  }

  hasRunningWork(sessionID: string): boolean {
    const family = this.family(sessionID)
    for (const id of family) {
      const record = this.records.get(id)
      if (record !== undefined && (record.status === "running" || record.pending)) return true
    }
    for (const shell of this.shells.values()) {
      if (family.has(shell.owner) || shell.root === sessionID) return true
    }
    for (const image of this.images.values()) {
      if (family.has(image.owner)) return true
    }
    return false
  }

  shellCount(): number {
    return this.shells.size
  }

  private upsert(info: SessionListInfo): void {
    const created = Number(info.time?.created)
    const updated = Number(info.time?.updated)
    const now = Date.now()
    const existing = this.records.get(info.id)
    // A live event may be newer than the snapshot used for a reconnect seed.
    if (existing && Number.isFinite(updated) && existing.updatedAt > updated) return
    const record: TrackerInfo = {
      id: info.id,
      ...(info.parentID === undefined ? {} : { parentID: info.parentID }),
      ...(info.title === undefined ? {} : { title: info.title }),
      ...(info.location?.directory === undefined ? {} : { directory: info.location.directory }),
      status: isSessionBusy(info) ? "running" : "idle",
      pending: false,
      createdAt: Number.isFinite(created) ? created : now,
      updatedAt: Number.isFinite(updated) ? updated : now,
    }
    this.records.set(info.id, record)
    if (record.parentID !== undefined) this.indexChild(record.parentID, record.id)
  }

  private ensure(sessionID: string, now = Date.now()): TrackerInfo {
    const existing = this.records.get(sessionID)
    if (existing) return existing
    const record: TrackerInfo = {
      id: sessionID,
      status: "idle",
      pending: false,
      createdAt: now,
      updatedAt: now,
    }
    this.records.set(sessionID, record)
    return record
  }

  private remove(sessionID: string): void {
    const record = this.records.get(sessionID)
    if (record?.parentID !== undefined) this.children.get(record.parentID)?.delete(sessionID)
    this.records.delete(sessionID)
    this.children.delete(sessionID)
    // A running shell is kept until its exit/deleted event: deleting the owner does not
    // prove the process is gone. Images die with their session and have no exit event.
    for (const [key, image] of this.images) {
      if (image.owner === sessionID) this.images.delete(key)
    }
  }

  private indexChild(parentID: string, childID: string): void {
    const list = this.children.get(parentID) ?? new Set<string>()
    list.add(childID)
    this.children.set(parentID, list)
  }
}

async function listAll(list: SessionList): Promise<SessionListInfo[]> {
  const result: SessionListInfo[] = []
  let cursor: string | undefined
  for (let page = 0; page < MAX_SEED_PAGES; page += 1) {
    const response = await list({
      limit: SEED_PAGE_SIZE,
      order: "desc",
      archived: false,
      ...(cursor === undefined ? {} : { cursor }),
    })
    if (!response || !Array.isArray(response.data)) break
    for (const info of response.data) {
      if (info && typeof info.id === "string") result.push(info)
    }
    const next = response.cursor?.next
    if (typeof next !== "string" || !next) break
    cursor = next
  }
  return result
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

function imageKey(owner: string, path: string): string {
  return `${owner}\u0000${path}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
