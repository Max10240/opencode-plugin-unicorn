import { TranscriptIndex, type Message } from "./search.js"

export type SessionInfo = { time?: { updated?: number }; revert?: { messageID: string } }
export type Page = { data: Message[]; cursor: { next?: string | null } }
export type Source = {
  info(sessionID: string, signal: AbortSignal): Promise<SessionInfo>
  page(sessionID: string, type: "user" | "assistant" | "compaction", cursor: string | undefined, signal: AbortSignal): Promise<Page>
}

export class SessionSearchController {
  readonly index = new TranscriptIndex()
  sessionID: string | undefined
  loading = false
  ready = false
  error: string | undefined
  private request: AbortController | undefined
  private complete = false
  private dirty = true
  private updated: number | undefined
  constructor(private source: Source, private changed: () => void) {}
  invalidate(structural = false) { this.dirty = true; if (structural) { this.ready = false; this.changed() } }
  merge(message: Message) { this.dirty = true; if (this.index.upsert(message)) this.changed() }
  cancel() { this.request?.abort(); this.request = undefined; this.loading = false; this.ready = false }
  dispose() { this.cancel(); this.index.clear(); this.sessionID = undefined; this.complete = false }
  async open(sessionID: string, owner?: AbortSignal) {
    this.cancel()
    if (this.sessionID !== sessionID) { this.index.clear(); this.complete = false; this.updated = undefined }
    this.sessionID = sessionID
    this.ready = false
    this.loading = true; this.error = undefined; this.changed()
    const request = new AbortController()
    this.request = request
    const abort = () => {
      request.abort()
      if (this.request === request) { this.request = undefined; this.loading = false; this.ready = false; this.changed() }
    }
    owner?.addEventListener("abort", abort, { once: true })
    if (owner?.aborted) abort()
    const current = () => this.request === request && !request.signal.aborted
    try {
      request.signal.throwIfAborted()
      const info = await this.source.info(sessionID, request.signal)
      if (!current()) return
      if (this.complete && !this.dirty && this.updated !== undefined && info.time?.updated === this.updated) { this.ready = true; return }
      this.index.clear(); this.complete = false; this.dirty = false
      this.index.revertID = info.revert?.messageID
      this.updated = info.time?.updated
      this.ready = true
      this.changed()
      const load = async (type: "user" | "assistant" | "compaction") => {
        let cursor: string | undefined
        const seen = new Set<string>()
        do {
          const page = await this.source.page(sessionID, type, cursor, request.signal)
          if (!current()) return
          for (const message of page.data) this.index.upsert(message)
          this.changed()
          const next = page.cursor.next ?? undefined
          if (next && seen.has(next)) throw new Error("Repeated history cursor; retry session search")
          if (next) seen.add(next)
          cursor = next
          await new Promise<void>((resolve) => setTimeout(resolve, 0))
        } while (cursor && current())
      }
      // Keep at most two history requests in flight and discard non-dialogue payloads page by page.
      await Promise.all([load("user"), load("assistant")])
      if (current()) await load("compaction")
      if (current()) this.complete = true
    } catch (error) {
      if (!current()) return
      this.index.clear(); this.complete = false
      this.error = error instanceof Error ? error.message : String(error)
      request.abort(); this.request = undefined; this.loading = false; this.ready = false; this.changed()
    } finally {
      owner?.removeEventListener("abort", abort)
      if (current()) { this.request = undefined; this.loading = false; this.changed() }
    }
  }
}
