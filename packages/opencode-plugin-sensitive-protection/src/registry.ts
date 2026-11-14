import { lstat, mkdir, readFile, realpath, rename, unlink, writeFile } from "node:fs/promises"
import { randomUUID } from "node:crypto"
import path from "node:path"
import os from "node:os"
import { extractPrivateKey, patternsForValues } from "./extractors.js"
import type { ReadPolicy, WritePolicy } from "./options.js"
import type { ProtectionMatch, ProtectionPattern, ProtectionSource } from "./types.js"

export const REDACTION_TOKEN = "[REDACTED:PROTECTED]"

export type { ProtectionSource } from "./types.js"

export type ProtectionEntry = {
  readonly path: string
  readonly role: string
  readonly keyID?: string
  readonly label?: string
  readonly createdAt: number
  readonly read: ReadPolicy
  readonly write: WritePolicy
  readonly source: ProtectionSource
}

export type ProtectionFileInfo = ProtectionEntry & {
  readonly keys: readonly string[]
  readonly keyCount: number
}

type Entry = ProtectionEntry & {
  readonly patterns: readonly ProtectionPattern[]
}

export type MatchCollector = Map<string, ProtectionMatch>

type StoredEntry = ProtectionEntry

export class ProtectionRegistry {
  private readonly entries = new Map<string, Entry>()
  private readonly listeners = new Set<() => void>()
  private saveQueue: Promise<void> = Promise.resolve()
  private patternsCache: readonly string[] | undefined
  private directCache: readonly string[] | undefined
  private shortCache: readonly string[] | undefined
  private matcher: RegExp | undefined

  constructor(
    private readonly directory: string,
    private readonly maxContentBytes: number,
  ) {}

  get size() {
    return this.entries.size
  }

  onChange(listener: () => void) {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  list(): ProtectionFileInfo[] {
    return [...this.entries.values()]
      .map(({ patterns, ...entry }) => {
        const keys = [...new Set(patterns.map((pattern) => pattern.key).filter((key): key is string => typeof key === "string" && key.length > 0))]
        return { ...entry, keys, keyCount: keys.length }
      })
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

  async load() {
    const file = path.join(this.directory, "registry.json")
    let parsed: unknown
    try {
      parsed = JSON.parse(await readFile(file, "utf8"))
    } catch {
      return
    }
    if (!parsed || typeof parsed !== "object" || !Array.isArray((parsed as { entries?: unknown }).entries)) return
    for (const raw of (parsed as { entries: unknown[] }).entries) {
      if (!raw || typeof raw !== "object") continue
      const entry = raw as StoredEntry
      if (typeof entry.path !== "string" || typeof entry.role !== "string" || typeof entry.createdAt !== "number") continue
      try {
        await this.register(entry.path, {
          role: entry.role,
          keyID: entry.keyID,
          label: entry.label,
          createdAt: entry.createdAt,
          read: entry.read,
          write: entry.write,
          source: entry.source ?? "manual",
          persist: false,
        })
      } catch {
        // The file may have been removed since the registry was written.
      }
    }
  }

  async register(
    value: string,
    input: {
      role: string
      keyID?: string
      label?: string
      createdAt?: number
      read?: ReadPolicy
      write?: WritePolicy
      source?: ProtectionSource
      persist?: boolean
    },
  ) {
    const resolved = await realpath(value)
    const info = await lstat(resolved)
    if (!info.isFile()) throw new Error("Protected file must be a regular file")
    if (info.size > this.maxContentBytes) throw new Error(`Protected file exceeds the ${this.maxContentBytes} byte limit`)

    const content = await readFile(resolved)
    const result = this.setEntry(resolved, manualPatterns(content), {
      ...input,
      read: input.read ?? "block",
      write: input.write ?? "allow",
      source: input.source ?? "manual",
    })
    return { path: result.path, bytes: content.length }
  }

  async registerPatterns(
    value: string,
    patterns: readonly ProtectionPattern[],
    input: {
      role: string
      keyID?: string
      label?: string
      createdAt?: number
      read?: ReadPolicy
      write?: WritePolicy
      source?: ProtectionSource
      persist?: boolean
    },
  ) {
    const resolved = await realpath(value)
    const info = await lstat(resolved)
    if (!info.isFile()) throw new Error("Protected file must be a regular file")
    return this.setEntry(resolved, patterns, {
      ...input,
      read: input.read ?? "redact",
      write: input.write ?? "block",
      source: input.source ?? "custom",
    })
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

  async flush() {
    await this.queueSave()
  }

  private setEntry(
    resolved: string,
    patterns: readonly ProtectionPattern[],
    input: {
      role: string
      keyID?: string
      label?: string
      createdAt?: number
      read: ReadPolicy
      write: WritePolicy
      source: ProtectionSource
      persist?: boolean
    },
  ) {
    const unique = new Map<string, ProtectionPattern>()
    for (const pattern of patterns) if (pattern.value && !unique.has(pattern.value)) unique.set(pattern.value, pattern)
    const entry: Entry = {
      path: resolved,
      role: input.role,
      ...(input.keyID === undefined ? {} : { keyID: input.keyID }),
      ...(input.label === undefined ? {} : { label: input.label }),
      createdAt: input.createdAt ?? Date.now(),
      read: input.read,
      write: input.write,
      source: input.source,
      patterns: [...unique.values()].sort((left, right) => right.value.length - left.value.length),
    }
    this.entries.set(resolved, entry)
    this.invalidate()
    this.notifyChange()
    if (input.persist !== false && entry.source === "manual") void this.queueSave()
    return { path: resolved, bytes: entry.patterns.reduce((total, pattern) => total + pattern.value.length, 0) }
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

  private queueSave() {
    this.saveQueue = this.saveQueue.then(() => this.save()).catch(() => {})
    return this.saveQueue
  }

  private async save() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    const file = path.join(this.directory, "registry.json")
    const temporary = path.join(this.directory, `.registry.${randomUUID()}.tmp`)
    const entries: StoredEntry[] = [...this.entries.values()]
      .filter((entry) => entry.source === "manual")
      .map(({ patterns: _patterns, ...entry }) => entry)
    try {
      await writeFile(temporary, JSON.stringify({ version: 2, entries }, null, 2), { mode: 0o600, flag: "wx" })
      await rename(temporary, file)
    } finally {
      await unlink(temporary).catch(() => {})
    }
  }
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function manualPatterns(content: Buffer): ProtectionPattern[] {
  const text = content.toString("utf8")
  if (!text) return []
  const privateKey = extractPrivateKey(text)
  if (privateKey.length > 0) return patternsForValues(privateKey)
  // A private key marker with no usable body has no secret to extract; do not
  // fall back to registering the marker lines themselves.
  if (text.includes("PRIVATE KEY")) return []
  return buildPatterns(content)
}

function buildPatterns(content: Buffer): ProtectionPattern[] {
  const text = content.toString("utf8")
  if (!text) return []
  const patterns = new Map<string, string>()
  const add = (value: string | undefined, key: string) => {
    if (value && value.length >= 8 && !patterns.has(value)) patterns.set(value, key)
  }
  add(text, "whole file")
  for (const line of text.split("\n")) {
    add(line.replace(/\r$/, ""), "line")
  }
  const escaped = JSON.stringify(text).slice(1, -1)
  if (escaped !== text) {
    add(escaped, "whole file")
    for (const line of escaped.split("\\n")) add(line, "line")
  }
  if (content.length <= 1024 * 1024) {
    add(content.toString("base64"), "whole file (base64)")
    add(content.toString("base64url"), "whole file (base64url)")
    add(content.toString("hex"), "whole file (hex)")
    add(content.toString("hex").toUpperCase(), "whole file (hex)")
  }
  return [...patterns]
    .sort(([left], [right]) => right.length - left.length)
    .map(([value, key]) => ({ value, key }))
}

export async function resolveProtectedPath(value: string, directory: string) {
  if (typeof value !== "string" || !value.trim()) throw new Error("file must be a non-empty path")
  const root = path.resolve(os.tmpdir())
  const expanded = value === "~" ? process.env.HOME ?? "" : value.startsWith("~/") ? path.join(process.env.HOME ?? "", value.slice(2)) : value === "$TMPDIR" || value === "${TMPDIR}" ? root : value.startsWith("$TMPDIR/") ? path.join(root, value.slice(8)) : value.startsWith("${TMPDIR}/") ? path.join(root, value.slice(11)) : value
  const candidate = path.isAbsolute(expanded) ? expanded : path.resolve(directory, expanded)
  return realpath(candidate)
}

export async function fileIsRegular(value: string) {
  const info = await lstat(value).catch(() => undefined)
  return info?.isFile() === true
}
