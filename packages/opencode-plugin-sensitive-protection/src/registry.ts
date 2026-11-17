import type { ProtectionMatch, ProtectionPattern, ProtectionSource } from "./types.js"
import type { ExtractFormat } from "./spec.js"

export const REDACTION_TOKEN = "[REDACTED:PROTECTED]"

export type { ProtectionSource } from "./types.js"

export type ProtectionEntry = {
  readonly path: string
  readonly source: ProtectionSource
  readonly format?: ExtractFormat
  readonly keys: readonly string[]
  readonly label?: string
  readonly role?: string
  readonly keyID?: string
  readonly createdAt: number
  readonly invalid?: string
}

export type ProtectionFileInfo = ProtectionEntry & {
  readonly keyCount: number
  readonly project?: string
  readonly projects?: readonly string[]
  readonly disabled?: boolean
  readonly pending?: boolean
}

type Entry = ProtectionEntry & {
  readonly patterns: readonly ProtectionPattern[]
}

export type MatchCollector = Map<string, ProtectionMatch>

export class ProtectionRegistry {
  private readonly entries = new Map<string, Entry>()
  private readonly listeners = new Set<() => void>()
  private patternsCache: readonly string[] | undefined
  private directCache: readonly string[] | undefined
  private shortCache: readonly string[] | undefined
  private matcher: RegExp | undefined

  get size() {
    return this.entries.size
  }

  onChange(listener: () => void) {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  list(): ProtectionFileInfo[] {
    return [...this.entries.values()]
      .map(({ patterns: _patterns, ...entry }) => ({ ...entry, keyCount: entry.keys.length }))
      .sort((left, right) => left.path.localeCompare(right.path))
  }

  has(value: string) {
    return this.entries.has(value)
  }

  get(value: string): ProtectionEntry | undefined {
    const entry = this.entries.get(value)
    if (!entry) return
    const { patterns: _patterns, ...publicEntry } = entry
    return publicEntry
  }

  set(entry: ProtectionEntry, patterns: readonly ProtectionPattern[]) {
    const unique = new Map<string, ProtectionPattern>()
    for (const pattern of patterns) if (pattern.value && !unique.has(pattern.value)) unique.set(pattern.value, pattern)
    const next: Entry = {
      ...entry,
      keys: [...new Set(entry.keys)],
      patterns: [...unique.values()].sort((left, right) => right.value.length - left.value.length),
    }
    this.entries.set(entry.path, next)
    this.invalidate()
    this.notifyChange()
  }

  remove(value: string) {
    const removed = this.entries.delete(value)
    if (!removed) return false
    this.invalidate()
    this.notifyChange()
    return true
  }

  redact(text: string) {
    return this.redactWithCount(text).text
  }

  createMatchCollector(): MatchCollector {
    return new Map()
  }

  matchList(collector: MatchCollector): ProtectionMatch[] {
    return [...collector.values()].sort((left, right) =>
      (left.file ?? "").localeCompare(right.file ?? "") || (left.key ?? "").localeCompare(right.key ?? "")
    )
  }

  redactWithCount(text: string, collector?: MatchCollector): { text: string; count: number } {
    if (!text) return { text, count: 0 }
    const patterns = this.patternsCache ??= [...new Set([...this.entries.values()].flatMap((entry) => entry.patterns.map((pattern) => pattern.value)))]
    if (patterns.length === 0) return { text, count: 0 }
    const direct = this.directCache ??= patterns.filter((pattern) => pattern.length > 256)
    const short = this.shortCache ??= patterns.filter((pattern) => pattern.length <= 256)
    if (!direct.some((pattern) => text.includes(pattern)) && !this.matchesShort(text, short)) {
      return { text, count: 0 }
    }
    let value = text
    let count = 0
    for (const entry of this.entries.values()) {
      for (const pattern of entry.patterns) {
        if (!pattern.value || !value.includes(pattern.value)) continue
        const parts = value.split(pattern.value)
        const found = parts.length - 1
        if (found === 0) continue
        count += found
        value = parts.join(REDACTION_TOKEN)
        if (collector) this.collectMatch(collector, entry, pattern, found)
      }
    }
    return { text: value, count }
  }

  redactValue(value: unknown, collector?: MatchCollector): { value: unknown; changed: boolean; count: number } {
    if (this.entries.size === 0) return { value, changed: false, count: 0 }
    if (typeof value === "string") {
      const result = this.redactWithCount(value, collector)
      return { value: result.text, changed: result.count > 0, count: result.count }
    }
    if (Array.isArray(value)) {
      let next: unknown[] | undefined
      let count = 0
      for (let index = 0; index < value.length; index++) {
        const result = this.redactValue(value[index], collector)
        count += result.count
        if (result.changed) {
          if (!next) next = value.slice(0, index)
          next.push(result.value)
        } else if (next) {
          next.push(value[index])
        }
      }
      return next ? { value: next, changed: true, count } : { value, changed: false, count }
    }
    if (value && typeof value === "object") {
      let next: Record<string, unknown> | undefined
      let count = 0
      for (const [key, item] of Object.entries(value)) {
        const result = this.redactValue(item, collector)
        count += result.count
        if (result.changed) {
          if (!next) next = { ...(value as Record<string, unknown>) }
          next[key] = result.value
        } else if (next) {
          next[key] = item
        }
      }
      return next ? { value: next, changed: true, count } : { value, changed: false, count }
    }
    return { value, changed: false, count: 0 }
  }

  private collectMatch(collector: MatchCollector, entry: Entry, pattern: ProtectionPattern, count: number) {
    const key = `${entry.path}\u0000${entry.source}\u0000${pattern.key ?? ""}`
    const existing = collector.get(key)
    if (existing) {
      collector.set(key, { ...existing, count: existing.count + count })
      return
    }
    collector.set(key, {
      file: entry.path,
      ...(entry.label === undefined ? {} : { label: entry.label }),
      source: entry.source,
      ...(pattern.key === undefined ? {} : { key: pattern.key }),
      count,
    })
  }

  private matchesShort(text: string, patterns: readonly string[]) {
    if (patterns.length === 0) return false
    const regex = this.regex(patterns)
    if (!regex) return patterns.some((pattern) => text.includes(pattern))
    return regex.test(text)
  }

  private regex(patterns: readonly string[]) {
    if (this.matcher) return this.matcher
    if (patterns.length > 5_000) return undefined
    try {
      this.matcher = new RegExp(patterns.map(escapeRegExp).join("|"))
      return this.matcher
    } catch {
      return undefined
    }
  }

  private notifyChange() {
    for (const listener of this.listeners) {
      try {
        listener()
      } catch {
        // A listener failure must not break registry updates.
      }
    }
  }

  private invalidate() {
    this.patternsCache = undefined
    this.directCache = undefined
    this.shortCache = undefined
    this.matcher = undefined
  }
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}
