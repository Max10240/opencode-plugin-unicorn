import type { Context } from "@opencode/plugin/tui/context"

export interface PromptEntry {
  readonly sessionID: string
  readonly messageID: string
  readonly text: string
  readonly title?: string
  readonly directory?: string
  readonly projectID?: string
  readonly created: number
}

export const DEFAULT_MAX_PROMPTS = 2_000

export function resolveMaxPrompts(value: unknown) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : DEFAULT_MAX_PROMPTS
}

type CachedSession = {
  updated: number
  inbox?: string
  exported?: boolean
  prompts: PromptEntry[]
  truncatedAtMax?: number
}

type Cache = {
  version: 1
  sessions: Record<string, CachedSession>
}

const SESSION_PAGE_SIZE = 100
const FETCH_CONCURRENCY = 6
const MAX_PROMPT_CHARS = 100_000

export class PromptIndexer {
  readonly cache: Cache
  private readonly updateCache: (mutation: (draft: Cache) => void) => Promise<void>
  private readonly maxPrompts: number
  private readonly normalizeCache: Promise<void>
  private readonly dirty = new Set<string>()
  private refreshing: Promise<void> | undefined

  constructor(private readonly context: Context, maxPrompts: unknown = DEFAULT_MAX_PROMPTS) {
    this.maxPrompts = resolveMaxPrompts(maxPrompts)
    const [cache, updateCache] = context.storage.store<Cache>("prompt-search.index", {
      initial: { version: 1, sessions: {} },
    })
    this.cache = cache
    this.updateCache = updateCache
    this.normalizeCache = countPrompts(cache.sessions) > this.maxPrompts
      ? updateCache((draft) => trimCache(draft.sessions, this.maxPrompts))
      : Promise.resolve()
  }

  entries() {
    return Object.values(this.cache.sessions)
      .flatMap((session) => session.prompts)
      .sort((left, right) => right.created - left.created)
      .slice(0, this.maxPrompts)
  }

  search(
    query: string,
    limit = 100,
    options: { readonly projectID?: string; readonly scope?: "project" | "all" } = {},
  ) {
    const normalized = query.trim().toLowerCase()
    const scoped = options.scope === "project" && options.projectID
      ? this.entries().filter((entry) => entry.projectID === options.projectID)
      : this.entries()
    if (!normalized) return scoped.slice(0, limit)

    const terms = normalized.split(/\s+/).filter(Boolean)
    return scoped
      .map((entry) => ({ entry, score: score(entry, normalized, terms) }))
      .filter((item) => item.score > 0)
      .sort((left, right) =>
        right.entry.created - left.entry.created ||
        right.score - left.score ||
        right.entry.messageID.localeCompare(left.entry.messageID)
      )
      .slice(0, limit)
      .map((item) => item.entry)
  }

  invalidate(sessionID: string) {
    this.dirty.add(sessionID)
  }

  async refresh() {
    if (this.refreshing) return this.refreshing
    this.refreshing = this.refreshInternal().finally(() => {
      this.refreshing = undefined
    })
    return this.refreshing
  }

  private async refreshInternal() {
    await this.normalizeCache
    if (this.maxPrompts === 0) {
      await this.updateCache((draft) => {
        draft.sessions = {}
      })
      return
    }

    const sessions = await listSessions(this.context)
    const subagentSessions = sessions.filter((session) => Boolean(session.parentID))
    const indexableSessions = sessions.filter((session) => !session.parentID)
    const liveSessionIDs = new Set(indexableSessions.map((session) => session.id))
    const next: Record<string, CachedSession> = {}
    const successfullyExported = new Set<string>()

    for (let offset = 0; offset < indexableSessions.length; offset += FETCH_CONCURRENCY) {
      const batch = indexableSessions.slice(offset, offset + FETCH_CONCURRENCY)
      const results = await Promise.all(batch.map((session) => this.readSession(session)))
      for (const [sessionID, value, exported] of results) {
        next[sessionID] = value
        if (exported) successfullyExported.add(sessionID)
      }
      // Keep the UI responsive and let pending input events render between batches.
      await Promise.resolve()
    }

    await this.updateCache((draft) => {
      // Subagent sessions are separate transcripts; their task prompts are not user prompts.
      for (const session of subagentSessions) delete draft.sessions[session.id]
      // A session missing from the server list may have been deleted after it was indexed.
      Object.assign(draft.sessions, next)
      trimCache(draft.sessions, this.maxPrompts, successfullyExported)
      for (const [sessionID, session] of Object.entries(draft.sessions)) {
        if (session.prompts.length === 0 && !liveSessionIDs.has(sessionID)) delete draft.sessions[sessionID]
      }
    })
  }

  private async readSession(session: any): Promise<[string, CachedSession, boolean]> {
    const updated = Number(session.time?.updated ?? session.time?.created ?? 0)
    const projectID = typeof session.projectID === "string" ? session.projectID : undefined
    const cached = this.cache.sessions[session.id]
    const forced = this.dirty.has(session.id)
    const hasProjectIDs = projectID === undefined || cached?.prompts.every((prompt) => prompt.projectID === projectID) === true
    if (
      !forced &&
      hasProjectIDs &&
      cached?.updated === updated &&
      cached.inbox !== undefined &&
      cached.exported !== false &&
      (cached.truncatedAtMax === undefined || cached.truncatedAtMax >= this.maxPrompts)
    )
      return [session.id, cached, false]

    let pending: SessionInboxEntry[] = []
    let inboxFailed = false
    try {
      pending = await this.context.client.session.inbox.list({ sessionID: session.id }) as SessionInboxEntry[]
    } catch {
      inboxFailed = true
    }
    const inbox = inboxFailed ? undefined : inboxSignature(pending)
    if (
      !forced &&
      hasProjectIDs &&
      !inboxFailed &&
      cached?.updated === updated &&
      cached.inbox === inbox &&
      cached.exported !== false &&
      (cached.truncatedAtMax === undefined || cached.truncatedAtMax >= this.maxPrompts)
    )
      return [session.id, cached, false]
    if (inboxFailed && cached) return [session.id, cached, false]

    const pendingPrompts = pending
      .filter((item) => item.type === "user" && typeof item.payload?.text === "string")
      .map((item) => ({
        sessionID: session.id,
        messageID: item.id,
        text: item.payload!.text!.slice(0, MAX_PROMPT_CHARS),
        title: session.title,
        directory: session.location?.directory,
        projectID,
        created: Number(item.time?.created ?? updated),
      } satisfies PromptEntry))
    try {
      const exported = await this.context.client.session.export({ sessionID: session.id })
      const prompts = new Map<string, PromptEntry>()
      for (const message of exported.messages ?? []) {
        if (message.type !== "user" || typeof message.text !== "string") continue
        prompts.set(message.id, {
          sessionID: session.id,
          messageID: message.id,
          text: message.text.slice(0, MAX_PROMPT_CHARS),
          title: session.title,
          directory: session.location?.directory,
          projectID,
          created: Number(message.time?.created ?? updated),
        })
      }
      for (const prompt of pendingPrompts) if (!prompts.has(prompt.messageID)) prompts.set(prompt.messageID, prompt)
      const result = [...prompts.values()].sort((left, right) => right.created - left.created)
      this.dirty.delete(session.id)
      return [session.id, { updated, inbox, exported: true, prompts: result }, true]
    } catch {
      return [session.id, cached ?? { updated, inbox, exported: false, prompts: pendingPrompts }, false]
    }
  }
}

function countPrompts(sessions: Cache["sessions"]) {
  return Object.values(sessions).reduce((count, session) => count + session.prompts.length, 0)
}

function trimCache(
  sessions: Cache["sessions"],
  maxPrompts: number,
  successfullyExported: ReadonlySet<string> = new Set(),
) {
  const prompts = Object.values(sessions).flatMap((session) => session.prompts)
  if (prompts.length <= maxPrompts) return

  const retained = new Set(prompts.sort((left, right) => right.created - left.created).slice(0, maxPrompts))
  for (const [sessionID, session] of Object.entries(sessions)) {
    const kept = session.prompts.filter((prompt) => retained.has(prompt))
    if (
      kept.length < session.prompts.length &&
      (session.truncatedAtMax === undefined || session.truncatedAtMax >= maxPrompts || successfullyExported.has(sessionID))
    )
      session.truncatedAtMax = maxPrompts
    session.prompts = kept
  }
}

type SessionInboxEntry = {
  readonly id: string
  readonly type: string
  readonly payload?: { readonly text?: string }
  readonly delivery?: string
  readonly time?: { readonly created?: number }
}

function inboxSignature(items: readonly SessionInboxEntry[]) {
  return items
    .filter((item) => item.type === "user")
    .map((item) => [item.id, item.time?.created ?? 0, item.delivery ?? "", item.payload?.text?.length ?? 0].join(":"))
    .sort()
    .join("|")
}

async function listSessions(context: Context) {
  const sessions: any[] = []
  let cursor: string | undefined
  do {
    const page = await context.client.session.list({ limit: SESSION_PAGE_SIZE, order: "desc", cursor })
    sessions.push(...page.data)
    cursor = page.cursor.next ?? undefined
  } while (cursor)
  return sessions
}

function score(entry: PromptEntry, query: string, terms: readonly string[]) {
  const text = entry.text.toLowerCase()
  const title = entry.title?.toLowerCase() ?? ""
  if (text === query) return 10_000
  if (text.startsWith(query)) return 8_000
  if (text.includes(query)) return 6_000
  if (terms.every((term) => text.includes(term))) return 4_000 + terms.length
  if (terms.some((term) => text.includes(term) || title.includes(term))) return 1_000
  return 0
}
