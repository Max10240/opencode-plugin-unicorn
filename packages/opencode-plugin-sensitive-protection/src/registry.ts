import { lstat, mkdir, readFile, realpath, rename, stat, unlink, writeFile } from "node:fs/promises"
import { randomUUID } from "node:crypto"
import path from "node:path"
import os from "node:os"

export const REDACTION_TOKEN = "[REDACTED:PROTECTED]"

type Entry = {
  readonly path: string
  readonly role: string
  readonly keyID?: string
  readonly label?: string
  readonly createdAt: number
  readonly patterns: readonly string[]
}

type StoredEntry = Omit<Entry, "patterns">

export class ProtectionRegistry {
  private readonly entries = new Map<string, Entry>()
  private saveQueue: Promise<void> = Promise.resolve()

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
      persist?: boolean
    },
  ) {
    const resolved = await realpath(value)
    const info = await lstat(resolved)
    if (info.isSymbolicLink()) throw new Error("Protected file must not be a symbolic link")
    if (!info.isFile()) throw new Error("Protected file must be a regular file")
    if (info.size > this.maxContentBytes) throw new Error(`Protected file exceeds the ${this.maxContentBytes} byte limit`)

    const content = await readFile(resolved)
    const patterns = buildPatterns(content)
    const entry: Entry = {
      path: resolved,
      role: input.role,
      ...(input.keyID === undefined ? {} : { keyID: input.keyID }),
      ...(input.label === undefined ? {} : { label: input.label }),
      createdAt: input.createdAt ?? Date.now(),
      patterns,
    }
    this.entries.set(resolved, entry)
    if (input.persist !== false) void this.queueSave()
    return { path: resolved, bytes: content.length }
  }

  redact(text: string) {
    let value = text
    for (const entry of this.entries.values()) {
      for (const pattern of entry.patterns) {
        if (pattern && value.includes(pattern)) value = value.split(pattern).join(REDACTION_TOKEN)
      }
    }
    return value
  }

  redactValue(value: unknown): { value: unknown; changed: boolean } {
    if (this.entries.size === 0) return { value, changed: false }
    if (typeof value === "string") {
      const next = this.redact(value)
      return { value: next, changed: next !== value }
    }
    if (Array.isArray(value)) {
      let changed = false
      const next = value.map((item) => {
        const result = this.redactValue(item)
        if (result.changed) changed = true
        return result.value
      })
      return { value: next, changed }
    }
    if (value && typeof value === "object") {
      let changed = false
      const next: Record<string, unknown> = {}
      for (const [key, item] of Object.entries(value)) {
        const result = this.redactValue(item)
        if (result.changed) changed = true
        next[key] = result.value
      }
      return { value: next, changed }
    }
    return { value, changed: false }
  }

  async flush() {
    await this.queueSave()
  }

  private queueSave() {
    this.saveQueue = this.saveQueue.then(() => this.save()).catch(() => {})
    return this.saveQueue
  }

  private async save() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    const file = path.join(this.directory, "registry.json")
    const temporary = path.join(this.directory, `.registry.${randomUUID()}.tmp`)
    const entries: StoredEntry[] = [...this.entries.values()].map(({ patterns: _patterns, ...entry }) => entry)
    try {
      await writeFile(temporary, JSON.stringify({ version: 1, entries }, null, 2), { mode: 0o600, flag: "wx" })
      await rename(temporary, file)
    } finally {
      await unlink(temporary).catch(() => {})
    }
  }
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
  const info = await stat(value).catch(() => undefined)
  return info?.isFile() === true
}
