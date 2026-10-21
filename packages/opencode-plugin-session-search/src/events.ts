export function searchEvent(type: string): "reload" | "text" | "settled" | undefined {
  if (type === "session.compaction.ended" || type.startsWith("session.revert.") || type === "session.message.content.updated" || type.startsWith("session.inbox.") || type === "session.deleted") return "reload"
  if (/^session\.execution\.(succeeded|failed|interrupted)$/.test(type)) return "settled"
  if (type.startsWith("session.text.")) return "text"
}

export function eventForSession(type: string, data: unknown, sessionID?: string) {
  if (!sessionID || typeof data !== "object" || data === null || !("sessionID" in data) || data.sessionID !== sessionID) return
  return searchEvent(type)
}
