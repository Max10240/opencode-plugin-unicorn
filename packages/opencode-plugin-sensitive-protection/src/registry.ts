import { lstat, mkdir, readFile, realpath, rename, unlink, writeFile } from "node:fs/promises"
import { randomUUID } from "node:crypto"
import path from "node:path"
import os from "node:os"
import type { ReadPolicy, WritePolicy } from "./options.js"

export const REDACTION_TOKEN = "[REDACTED:PROTECTED]"

export type ProtectionSource = "manual" | "builtin" | "custom"

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

type Entry = ProtectionEntry & {
  readonly patterns: readonly string[]
}

type StoredEntry = ProtectionEntry

export class ProtectionRegistry {
  private readonly entries = new Map<string, Entry>()
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
    const result = this.setEntry(resolved, buildPatterns(content), {
      ...input,
      read: input.read ?? "block",
      write: input.write ?? "allow",
      source: input.source ?? "manual",
    })
    return { path: result.path, bytes: content.length }
  }

  async registerPatterns(
    value: string,
    patterns: readonly string[],
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
    return true
  }

  redact(text: string) {
    return this.redactWithCount(text).text
  }

  redactWithCount(text: string): { text: string; count: number } {
    if (!text) return { text, count: 0 }
    const patterns = this.patternsCache ??= [...new Set([...this.entries.values()].flatMap((entry) => entry.patterns))]
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
        if (!pattern || !value.includes(pattern)) continue
        const parts = value.split(pattern)
        count += parts.length - 1
        value = parts.join(REDACTION_TOKEN)
      }
    }
    return { text: value, count }
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

  redactValue(value: unknown): { value: unknown; changed: boolean; count: number } {
    if (this.entries.size === 0) return { value, changed: false, count: 0 }
    if (typeof value === "string") {
      const result = this.redactWithCount(value)
      return { value: result.text, changed: result.count > 0, count: result.count }
    }
    if (Array.isArray(value)) {
      let next: unknown[] | undefined
      let count = 0
      for (let index = 0; index < value.length; index++) {
        const result = this.redactValue(value[index])
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
        const result = this.redactValue(item)
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
    patterns: readonly string[],
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
    const entry: Entry = {
      path: resolved,
      role: input.role,
      ...(input.keyID === undefined ? {} : { keyID: input.keyID }),
      ...(input.label === undefined ? {} : { label: input.label }),
      createdAt: input.createdAt ?? Date.now(),
      read: input.read,
      write: input.write,
      source: input.source,
      patterns: [...new Set(patterns)].sort((left, right) => right.length - left.length),
    }
    this.entries.set(resolved, entry)
    this.invalidate()
    if (input.persist !== false && entry.source === "manual") void this.queueSave()
    return { path: resolved, bytes: entry.patterns.reduce((total, pattern) => total + pattern.length, 0) }
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

function buildPatterns(content: Buffer) {
  const text = content.toString("utf8")
  if (!text) return []
  const patterns = new Set<string>()
  const add = (value: string | undefined) => {
    if (value && value.length >= 8) patterns.add(value)
  }
  add(text)
  for (const line of text.split("\n")) {
    add(line.replace(/\r$/, ""))
  }
  const escaped = JSON.stringify(text).slice(1, -1)
  if (escaped !== text) {
    add(escaped)
    for (const line of escaped.split("\\n")) add(line)
  }
  if (content.length <= 1024 * 1024) {
    add(content.toString("base64"))
    add(content.toString("base64url"))
    add(content.toString("hex"))
    add(content.toString("hex").toUpperCase())
  }
  return [...patterns].sort((left, right) => right.length - left.length)
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
