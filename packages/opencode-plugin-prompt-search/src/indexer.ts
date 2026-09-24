import type { Context } from "@opencode/plugin/tui/context"

export interface PromptEntry {
  readonly sessionID: string
  readonly messageID: string
  readonly text: string
  readonly title?: string
  readonly directory?: string
  readonly created: number
}

export const DEFAULT_MAX_PROMPTS = 2_000

export function resolveMaxPrompts(value: unknown) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : DEFAULT_MAX_PROMPTS
}

type CachedSession = {
  updated: number
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

  search(query: string, limit = 100) {
    const normalized = query.trim().toLowerCase()
    const entries = this.entries()
    if (!normalized) return entries.slice(0, limit)

    const terms = normalized.split(/\s+/).filter(Boolean)
    return entries
      .map((entry) => ({ entry, score: score(entry, normalized, terms) }))
      .filter((item) => item.score > 0)
      .sort((left, right) => right.score - left.score || right.entry.created - left.entry.created)
      .slice(0, limit)
      .map((item) => item.entry)
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
    const liveSessionIDs = new Set(sessions.map((session) => session.id))
    const next: Record<string, CachedSession> = {}
    const successfullyExported = new Set<string>()

    for (let offset = 0; offset < sessions.length; offset += FETCH_CONCURRENCY) {
      const batch = sessions.slice(offset, offset + FETCH_CONCURRENCY)
      const results = await Promise.all(batch.map((session) => this.readSession(session)))
      for (const [sessionID, value, exported] of results) {
        next[sessionID] = value
        if (exported) successfullyExported.add(sessionID)
      }
      // Keep the UI responsive and let pending input events render between batches.
      await Promise.resolve()
    }

    await this.updateCache((draft) => {
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
    const cached = this.cache.sessions[session.id]
    if (
      cached?.updated === updated &&
      (cached.truncatedAtMax === undefined || cached.truncatedAtMax >= this.maxPrompts)
    )
      return [session.id, cached, false]

    try {
      const exported = await this.context.client.session.export({ sessionID: session.id })
      const prompts = (exported.messages ?? [])
        .filter((message: any) => message.type === "user" && typeof message.text === "string")
        .map((message: any) => ({
          sessionID: session.id,
          messageID: message.id,
          text: message.text.slice(0, MAX_PROMPT_CHARS),
          title: session.title,
          directory: session.location?.directory,
          created: Number(message.time?.created ?? updated),
        }))
      return [session.id, { updated, prompts }, true]
    } catch {
      return [session.id, cached ?? { updated, prompts: [] }, false]
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
