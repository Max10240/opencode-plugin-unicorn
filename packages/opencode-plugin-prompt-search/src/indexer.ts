import type { Context } from "@opencode/plugin/tui/context"

export interface PromptEntry {
  readonly sessionID: string
  readonly messageID: string
  readonly text: string
  readonly title?: string
  readonly directory?: string
  readonly created: number
}

type CachedSession = {
  updated: number
  prompts: PromptEntry[]
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
  private refreshing: Promise<void> | undefined

  constructor(private readonly context: Context) {
    const [cache, updateCache] = context.storage.store<Cache>("prompt-search.index", {
      initial: { version: 1, sessions: {} },
    })
    this.cache = cache
    this.updateCache = updateCache
  }

  entries() {
    return Object.values(this.cache.sessions)
      .flatMap((session) => session.prompts)
      .sort((left, right) => right.created - left.created)
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
    const sessions = await listSessions(this.context)
    const next: Record<string, CachedSession> = {}

    for (let offset = 0; offset < sessions.length; offset += FETCH_CONCURRENCY) {
      const batch = sessions.slice(offset, offset + FETCH_CONCURRENCY)
      const results = await Promise.all(batch.map((session) => this.readSession(session)))
      for (const [sessionID, value] of results) next[sessionID] = value
      // Keep the UI responsive and let pending input events render between batches.
      await Promise.resolve()
    }

    await this.updateCache((draft) => {
      draft.sessions = next
    })
  }

  private async readSession(session: any): Promise<[string, CachedSession]> {
    const updated = Number(session.time?.updated ?? session.time?.created ?? 0)
    const cached = this.cache.sessions[session.id]
    if (cached?.updated === updated) return [session.id, cached]

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
      return [session.id, { updated, prompts }]
    } catch {
      return [session.id, cached ?? { updated, prompts: [] }]
    }
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
