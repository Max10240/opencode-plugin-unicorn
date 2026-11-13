import { randomUUID } from "node:crypto"
import type { ProtectionHit, ProtectionHitInput, ProtectionMatch } from "./types.js"

const MAX_MATCHES = 12
const MAX_PATH = 1024
const MAX_LABEL = 200
const MAX_KEY = 200
const MAX_SESSION = 128
const MAX_TOOL = 64
const MAX_DETAIL = 300
const MAX_COUNT = 1_000_000_000

/**
 * In-memory, metadata-only history. Identical conditions are aggregated so a
 * redaction that repeats on every model request does not flood the log.
 */
export class ProtectionHistory {
  private readonly entries: ProtectionHit[] = []
  private readonly signatures = new Map<string, ProtectionHit>()
  private readonly prefix = `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`
  private sequence = 0

  constructor(readonly limit: number) {}

  get size() {
    return this.entries.length
  }

  record(input: ProtectionHitInput): ProtectionHit {
    const hit = sanitize(input)
    const signature = signatureOf(hit)
    const now = Date.now()
    const existing = this.signatures.get(signature)
    if (existing) {
      const updated: ProtectionHit = {
        ...existing,
        time: now,
        count: hit.count,
        ...(hit.label === undefined ? {} : { label: hit.label }),
        ...(hit.file === undefined ? {} : { file: hit.file }),
        ...(hit.tool === undefined ? {} : { tool: hit.tool }),
        ...(hit.detail === undefined ? {} : { detail: hit.detail }),
        ...(hit.matches === undefined ? {} : { matches: hit.matches }),
        occurrences: existing.occurrences + 1,
      }
      if (this.limit > 0) {
        const index = this.entries.findIndex((entry) => entry.id === existing.id)
        if (index >= 0) this.entries[index] = updated
      }
      this.signatures.set(signature, updated)
      return updated
    }

    const created: ProtectionHit = {
      ...hit,
      id: `${this.prefix}-${++this.sequence}`,
      time: now,
      firstTime: now,
      occurrences: 1,
    }
    this.signatures.set(signature, created)
    if (this.limit > 0) {
      this.entries.push(created)
      while (this.entries.length > this.limit) {
        const removed = this.entries.shift()
        if (removed) this.signatures.delete(signatureOf(removed))
      }
    } else {
      while (this.signatures.size > 64) {
        const oldest = this.signatures.keys().next().value
        if (oldest === undefined) break
        this.signatures.delete(oldest)
      }
    }
    return created
  }

  list(): ProtectionHit[] {
    return [...this.entries].sort((left, right) => right.firstTime - left.firstTime)
  }

  clear() {
    const count = this.entries.length
    this.entries.length = 0
    this.signatures.clear()
    return count
  }
}

function sanitize(input: ProtectionHitInput): ProtectionHitInput {
  const matches = input.matches?.length ? cleanMatches(input.matches) : undefined
  const label = cleanText(input.label, MAX_LABEL)
  const file = cleanText(input.file, MAX_PATH)
  const tool = cleanText(input.tool, MAX_TOOL)
  const sessionID = cleanText(input.sessionID, MAX_SESSION)
  const detail = cleanText(input.detail, MAX_DETAIL)
  return {
    kind: input.kind,
    source: input.source,
    count: cleanCount(input.count),
    ...(label === undefined ? {} : { label }),
    ...(file === undefined ? {} : { file }),
    ...(tool === undefined ? {} : { tool }),
    ...(sessionID === undefined ? {} : { sessionID }),
    ...(detail === undefined ? {} : { detail }),
    ...(matches === undefined ? {} : { matches }),
  }
}

function cleanMatches(matches: readonly ProtectionMatch[]) {
  const unique = new Map<string, ProtectionMatch>()
  for (const match of matches) {
    if (unique.size >= MAX_MATCHES) break
    const file = cleanText(match.file, MAX_PATH)
    const label = cleanText(match.label, MAX_LABEL)
    const key = cleanText(match.key, MAX_KEY)
    const source = match.source
    if (file === undefined && label === undefined && key === undefined) continue
    const identity = `${file ?? ""}\u0000${source ?? ""}\u0000${key ?? ""}`
    const count = cleanCount(match.count)
    const existing = unique.get(identity)
    if (existing) {
      unique.set(identity, { ...existing, count: Math.min(MAX_COUNT, existing.count + count) })
      continue
    }
    unique.set(identity, {
      ...(file === undefined ? {} : { file }),
      ...(label === undefined ? {} : { label }),
      ...(source === undefined ? {} : { source }),
      ...(key === undefined ? {} : { key }),
      count,
    })
  }
  return [...unique.values()]
}

function cleanText(value: string | undefined, max: number) {
  if (typeof value !== "string") return
  const cleaned = value.replace(/[\u0000-\u001F\u007F-\u009F]/g, " ").trim()
  if (!cleaned) return
  return cleaned.length > max ? `${cleaned.slice(0, max - 1)}…` : cleaned
}

function cleanCount(value: number) {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.min(MAX_COUNT, Math.floor(value)))
}

function signatureOf(hit: ProtectionHit | ProtectionHitInput) {
  const matches = (hit.matches ?? [])
    .map((match) => [match.file ?? "", match.source ?? "", match.key ?? ""])
    .sort((left, right) => left.join("\u0000").localeCompare(right.join("\u0000")))
  return JSON.stringify([
    hit.kind,
    hit.source,
    hit.sessionID ?? "",
    hit.tool ?? "",
    hit.detail ?? "",
    hit.file ?? "",
    hit.label ?? "",
    matches,
  ])
}
