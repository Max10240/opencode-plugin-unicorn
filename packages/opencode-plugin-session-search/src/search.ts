export type Message = {
  id: string
  type: string
  text?: string
  agent?: string
  time?: { created?: number }
  status?: string
  content?: readonly { type: string; text?: string }[]
}
export type Entry = {
  key: string
  messageID: string
  role: "user" | "assistant"
  ordinal?: number
  agent?: string
  text: string
  folded: string
  created: number
}
export type Match = Entry & { preview: string; beforeCompaction: boolean; reverted: boolean }
export type SearchResult = { matches: Match[]; total: number; error?: string }
export const MAX_QUERY_CHARS = 256

export function queuedMessage(messageID: string, pending: readonly { id: string; type: string }[]) {
  return pending.some((item) => item.type === "user" && item.id === messageID)
}

export function entriesFor(message: Message): Entry[] {
  if (message.type !== "user" && message.type !== "assistant") return []
  const base = { messageID: message.id, created: message.time?.created ?? 0, agent: message.agent }
  if (message.type === "user") {
    const text = message.text ?? ""
    return text.trim() ? [{ ...base, key: `${message.id}:user`, role: "user", text, folded: text.toLowerCase() }] : []
  }
  let ordinal = 0
  return (message.content ?? []).flatMap((part): Entry[] => {
    if (part.type !== "text") return []
    const index = ordinal++
    const text = part.text ?? ""
    return text.trim() ? [{ ...base, key: `${message.id}:text:${index}`, role: "assistant", ordinal: index, text, folded: text.toLowerCase() }] : []
  })
}

export class TranscriptIndex {
  private records = new Map<string, Entry[]>()
  private ordered: Entry[] | undefined
  private count = 0
  compactionTime: number | undefined
  revertID: string | undefined
  get size() { return this.count }
  clear() { this.records.clear(); this.count = 0; this.ordered = undefined; this.compactionTime = undefined; this.revertID = undefined }
  upsert(message: Message) {
    if (message.type === "compaction" && message.status === "completed") {
      const previous = this.compactionTime
      this.compactionTime = Math.max(this.compactionTime ?? 0, message.time?.created ?? 0)
      return previous !== this.compactionTime
    }
    const previous = this.records.get(message.id)
    const next = entriesFor(message)
    if (!next.length && !previous) return false
    if (previous?.length === next.length && next.every((entry, index) => entry.key === previous[index].key && entry.text === previous[index].text && entry.created === previous[index].created && entry.agent === previous[index].agent)) return false
    this.count += next.length - (previous?.length ?? 0)
    this.records.set(message.id, next)
    this.ordered = undefined
    return true
  }
  entries() {
    return this.ordered ??= [...this.records.values()].flat().sort((a, b) => b.created - a.created || b.messageID.localeCompare(a.messageID) || (a.ordinal ?? 0) - (b.ordinal ?? 0))
  }
  async search(query: string, signal?: AbortSignal, limit = 100, yieldWork = () => new Promise<void>((resolve) => setTimeout(resolve, 0))): Promise<SearchResult> {
    signal?.throwIfAborted()
    if (query.length > MAX_QUERY_CHARS) return { matches: [], total: 0, error: `Use at most ${MAX_QUERY_CHARS} query characters` }
    const terms = [...new Set(query.trim().toLowerCase().split(/\s+/).filter(Boolean))]
    const matches: Match[] = []
    const entries = this.entries()
    let total = terms.length ? 0 : entries.length
    const candidates = terms.length ? entries : entries.slice(0, limit)
    for (let index = 0; index < candidates.length; index++) {
      signal?.throwIfAborted()
      if (index && index % 256 === 0) { await yieldWork(); signal?.throwIfAborted() }
      const entry = candidates[index]
      if (!terms.every((term) => entry.folded.includes(term))) continue
      if (terms.length) total++
      if (matches.length >= limit) continue
      const at = terms.length ? Math.max(0, entry.folded.indexOf(terms[0]) - 60) : 0
      const preview = `${at ? "…" : ""}${entry.text.slice(at, at + 180).replace(/[\u0000-\u001f\u007f]/g, " ")}${entry.text.length > at + 180 ? "…" : ""}`
      matches.push({ ...entry, preview, beforeCompaction: this.compactionTime !== undefined && entry.created < this.compactionTime, reverted: this.revertID !== undefined && entry.messageID >= this.revertID })
    }
    return { matches, total }
  }
}
