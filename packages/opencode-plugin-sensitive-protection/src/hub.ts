import { randomUUID } from "node:crypto"
import { mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises"
import path from "node:path"
import type { ProtectionFileInfo } from "./registry.js"
import type { ProtectionSource } from "./types.js"
import { detectFormat, extractContent, isPrivateKey, patternsForValues, type ExtractFormat } from "./spec.js"

export type ManualEntry = {
  readonly path: string
  readonly format: ExtractFormat
  readonly keys: readonly string[]
  readonly label?: string
  readonly role?: string
  readonly keyID?: string
  readonly createdAt: number
  /** Set by legacy migration when the old entry cannot be represented safely. */
  readonly invalid?: string
}

export type DisabledEntry = {
  readonly path: string
  readonly source: ProtectionSource
  readonly project?: string
  readonly format?: ExtractFormat
  readonly keys?: readonly string[]
  readonly label?: string
  readonly createdAt: number
}

export type PendingRequest = {
  readonly id: string
  readonly path: string
  readonly source: ProtectionSource
  readonly project?: string
  readonly sessionID?: string
  readonly reason?: string
  readonly createdAt: number
}

export type LocationFile = {
  readonly path: string
  readonly source: "default" | "config"
  readonly format: ExtractFormat
  readonly keys: readonly string[]
  readonly keyCount: number
  readonly label?: string
  readonly project?: string
  readonly invalid?: string
}

export type ManualRuntime = {
  readonly entry: ManualEntry
  readonly patterns: readonly { value: string; key?: string }[]
  readonly invalid?: string
}

type StoredState = {
  version: 3
  manual: ManualEntry[]
  disabled: DisabledEntry[]
  pending: PendingRequest[]
}

type LocationState = {
  readonly directory: string
  readonly files: ReadonlyMap<string, LocationFile>
}

type ManualState = {
  entry: ManualEntry
  patterns: readonly { value: string; key?: string }[]
  invalid?: string
  signature?: string
}

const HUBS = Symbol.for("max10240.sensitive-protection.hubs")

export async function acquireHub(directory: string, maxContentBytes: number) {
  const map = hubMap()
  let hub = map.get(directory)
  if (!hub) {
    hub = new ProtectionHub(directory, maxContentBytes, () => map.delete(directory))
    map.set(directory, hub)
  }
  await hub.acquire()
  return hub
}

function hubMap(): Map<string, ProtectionHub> {
  const value = globalThis as typeof globalThis & { [HUBS]?: Map<string, ProtectionHub> }
  return value[HUBS] ??= new Map()
}

export class ProtectionHub {
  private readonly manual = new Map<string, ManualState>()
  private readonly disabled = new Map<string, DisabledEntry>()
  private readonly pending = new Map<string, PendingRequest>()
  private readonly configExclusions = new Map<string, Set<string>>()
  private readonly locations = new Map<string, LocationState>()
  private readonly listeners = new Set<() => void>()
  private loaded: Promise<void> | undefined
  private saveQueue: Promise<void> = Promise.resolve()
  private timer: NodeJS.Timeout | undefined
  private refs = 0

  constructor(
    private readonly directory: string,
    private readonly maxContentBytes: number,
    private readonly onEmpty: () => void,
  ) {}

  async acquire() {
    if (!this.loaded) this.loaded = this.load()
    await this.loaded
    this.refs++
    if (this.timer === undefined) {
      this.timer = setInterval(() => { void this.refreshManual() }, 2_000)
      this.timer.unref?.()
    }
  }

  async release() {
    this.refs = Math.max(0, this.refs - 1)
    if (this.refs > 0) return
    if (this.timer !== undefined) {
      clearInterval(this.timer)
      this.timer = undefined
    }
    await this.flush()
    this.listeners.clear()
    this.locations.clear()
    this.onEmpty()
  }

  onChange(listener: () => void) {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  isDisabled(value: string, project?: string, source?: ProtectionSource) {
    if (project !== undefined && this.configExclusions.get(project)?.has(value)) return true
    const entry = this.disabled.get(value)
    if (!entry) return false
    if (source !== undefined && entry.source !== source) return false
    if (entry.project === undefined) return true
    return project !== undefined && entry.project === project
  }

  setConfigExclusions(project: string, values: readonly string[]) {
    this.configExclusions.set(project, new Set(values))
    this.notify()
  }

  manualEntries(project?: string) {
    const result: ManualRuntime[] = []
    for (const item of this.manual.values()) {
      if (this.isDisabled(item.entry.path, project, "manual")) continue
      result.push({ entry: item.entry, patterns: item.patterns, ...(item.invalid === undefined ? {} : { invalid: item.invalid }) })
    }
    return result.sort((left, right) => left.entry.path.localeCompare(right.entry.path))
  }

  getManual(value: string) {
    return this.manual.get(value)?.entry
  }

  async addManual(entry: ManualEntry, patterns: readonly { value: string; key?: string }[]) {
    this.manual.set(entry.path, { entry, patterns })
    await this.save()
    this.notify()
  }

  async removeManual(value: string) {
    const removed = this.manual.delete(value)
    let pendingRemoved = false
    for (const [id, request] of this.pending) {
      if (request.path === value) {
        this.pending.delete(id)
        pendingRemoved = true
      }
    }
    if (!removed && !pendingRemoved) return false
    await this.save()
    this.notify()
    return true
  }

  async disable(input: {
    path: string
    source: ProtectionSource
    project?: string
    format?: ExtractFormat
    keys?: readonly string[]
    label?: string
  }) {
    this.disabled.set(input.path, {
      path: input.path,
      source: input.source,
      createdAt: Date.now(),
      ...(input.project === undefined ? {} : { project: input.project }),
      ...(input.format === undefined ? {} : { format: input.format }),
      ...(input.keys === undefined ? {} : { keys: input.keys }),
      ...(input.label === undefined ? {} : { label: input.label }),
    })
    await this.save()
    this.notify()
  }

  async restore(value: string) {
    const removed = this.disabled.delete(value)
    if (!removed) return false
    await this.save()
    this.notify()
    return true
  }

  setLocation(key: string, directory: string, files: readonly LocationFile[]) {
    const next = new Map(files.map((file) => [file.path, file]))
    const previous = this.locations.get(key)
    if (previous && sameLocation(previous, next)) return
    this.locations.set(key, { directory, files: next })
    this.notify()
  }

  removeLocation(key: string) {
    if (!this.locations.delete(key)) return
    this.notify()
  }

  catalog(): ProtectionFileInfo[] {
    type CatalogFile = {
      path: string
      source: ProtectionSource
      format?: ExtractFormat
      keys: readonly string[]
      keyCount: number
      label?: string
      role?: string
      keyID?: string
      createdAt: number
      invalid?: string
      project?: string
      projects: Set<string>
      disabled?: boolean
      pending?: boolean
    }
    const files = new Map<string, CatalogFile>()
    const add = (entry: Omit<CatalogFile, "projects"> & { project?: string }) => {
      const existing = files.get(entry.path)
      if (!existing) {
        files.set(entry.path, {
          ...entry,
          keyCount: entry.keys.length,
          projects: new Set(entry.project ? [entry.project] : []),
        })
        return
      }
      const priority = { default: 0, manual: 1, config: 2 } as const
      if (priority[entry.source] > priority[existing.source]) {
        existing.source = entry.source
        existing.format = entry.format
        existing.keys = entry.keys
        existing.keyCount = entry.keys.length
        existing.label = entry.label
        existing.invalid = entry.invalid
        existing.createdAt = entry.createdAt
      }
      if (entry.project) existing.projects.add(entry.project)
    }
    for (const item of this.manual.values()) {
      if (this.isDisabled(item.entry.path, undefined, "manual")) continue
      add({
        path: item.entry.path,
        source: "manual",
        format: item.entry.format,
        keys: item.entry.keys,
        keyCount: item.entry.keys.length,
        createdAt: item.entry.createdAt,
        ...(item.entry.label === undefined ? {} : { label: item.entry.label }),
        ...(item.invalid === undefined ? {} : { invalid: item.invalid }),
      })
    }
    for (const location of this.locations.values()) {
      for (const file of location.files.values()) {
        if (this.isDisabled(file.path, location.directory, file.source)) continue
        add({
          path: file.path,
          source: file.source,
          format: file.format,
          keys: file.keys,
          keyCount: file.keyCount,
          createdAt: 0,
          ...(file.label === undefined ? {} : { label: file.label }),
          ...(file.project === undefined ? {} : { project: file.project }),
          ...(file.invalid === undefined ? {} : { invalid: file.invalid }),
        })
      }
    }
    const disabledByPath = new Map<string, DisabledEntry>()
    const priority = { default: 0, manual: 1, config: 2 } as const
    for (const entry of this.disabled.values()) {
      const existing = disabledByPath.get(entry.path)
      if (!existing || priority[entry.source] > priority[existing.source]) disabledByPath.set(entry.path, entry)
    }
    for (const entry of disabledByPath.values()) {
      if (files.has(entry.path)) continue
      add({
        path: entry.path,
        source: entry.source,
        format: entry.format,
        keys: entry.keys ?? [],
        keyCount: entry.keys?.length ?? 0,
        createdAt: entry.createdAt,
        ...(entry.label === undefined ? {} : { label: entry.label }),
        ...(entry.project === undefined ? {} : { project: entry.project }),
        disabled: true,
      })
    }
    return [...files.values()]
      .map(({ projects, ...file }) => ({
        ...file,
        ...(projects.size === 0 ? {} : { projects: [...projects].sort() }),
        ...(this.pendingFor(file.path) ? { pending: true } : {}),
      }))
      .sort((left, right) => left.path.localeCompare(right.path))
  }

  async unprotect(value: string, project?: string) {
    const file = this.catalog().find((item) => item.path === value)
    if (!file) return { removed: false, disabled: false }
    if (file.source === "manual" && !file.disabled) {
      const removed = await this.removeManual(value)
      return { removed, disabled: false }
    }
    const targetProject = file.source === "config" ? file.project ?? project : undefined
    for (const [id, request] of this.pending) {
      if (request.path === value) this.pending.delete(id)
    }
    await this.disable({
      path: value,
      source: file.source,
      ...(targetProject === undefined ? {} : { project: targetProject }),
      ...(file.format === undefined ? {} : { format: file.format }),
      keys: file.keys,
      ...(file.label === undefined ? {} : { label: file.label }),
    })
    return { removed: false, disabled: true }
  }

  pendingFor(value: string) {
    for (const request of this.pending.values()) if (request.path === value) return request
  }

  listPending() {
    return [...this.pending.values()].sort((left, right) => right.createdAt - left.createdAt)
  }

  async addPending(input: {
    path: string
    source: ProtectionSource
    project?: string
    sessionID?: string
    reason?: string
  }) {
    const existing = this.pendingFor(input.path)
    if (existing) return existing
    const request: PendingRequest = {
      id: randomUUID(),
      path: input.path,
      source: input.source,
      createdAt: Date.now(),
      ...(input.project === undefined ? {} : { project: input.project }),
      ...(input.sessionID === undefined ? {} : { sessionID: input.sessionID }),
      ...(input.reason === undefined ? {} : { reason: input.reason }),
    }
    this.pending.set(request.id, request)
    await this.save()
    this.notify()
    return request
  }

  async resolvePending(id: string, approve: boolean) {
    const request = this.pending.get(id)
    if (!request) return false
    this.pending.delete(id)
    if (approve) {
      if (request.source === "manual") {
        this.manual.delete(request.path)
      } else {
        const file = this.catalog().find((item) => item.path === request.path)
        this.disabled.set(request.path, {
          path: request.path,
          source: request.source,
          createdAt: Date.now(),
          ...(request.project === undefined ? {} : { project: request.project }),
          ...(file?.format === undefined ? {} : { format: file.format }),
          ...(file?.keys === undefined ? {} : { keys: file.keys }),
          ...(file?.label === undefined ? {} : { label: file.label }),
        })
      }
    }
    for (const [pendingID, pending] of this.pending) {
      if (pending.path === request.path) this.pending.delete(pendingID)
    }
    await this.save()
    this.notify()
    return true
  }

  async flush() {
    await this.saveQueue
  }

  private notify() {
    for (const listener of this.listeners) {
      try {
        listener()
      } catch {
        // A listener failure must not break hub updates.
      }
    }
  }

  private async load() {
    let parsed: unknown
    try {
      parsed = JSON.parse(await readFile(path.join(this.directory, "registry.json"), "utf8"))
    } catch {
      return
    }
    if (!parsed || typeof parsed !== "object") return
    const state = parsed as Record<string, unknown>
    if (state.version === 3 && Array.isArray(state.manual)) {
      for (const raw of state.manual) {
        const entry = manualFrom(raw)
        if (entry) await this.loadManual(entry)
      }
      for (const raw of Array.isArray(state.disabled) ? state.disabled : []) {
        const entry = disabledFrom(raw)
        if (entry) this.disabled.set(entry.path, entry)
      }
      for (const raw of Array.isArray(state.pending) ? state.pending : []) {
        const entry = pendingFrom(raw)
        if (entry) this.pending.set(entry.id, entry)
      }
      return
    }
    if (Array.isArray(state.entries)) {
      for (const raw of state.entries) {
        const entry = await migrateLegacy(raw)
        if (entry) await this.loadManual(entry)
      }
      await this.save()
    }
  }

  private async loadManual(entry: ManualEntry) {
    if (entry.invalid) {
      this.manual.set(entry.path, { entry, patterns: [], invalid: entry.invalid })
      return
    }
    try {
      const info = await stat(entry.path)
      if (!info.isFile()) throw new Error("Path is not a regular file")
      if (info.size > this.maxContentBytes) throw new Error("File exceeds maxContentBytes")
      const content = await readFile(entry.path, "utf8")
      const result = extractContent(content, entry.format, entry.keys, { strict: true })
      if (result.missing.length > 0) {
        throw new Error(`Missing keys: ${result.missing.join(", ")}`)
      }
      const patterns = patternsForValues(result.values)
      if (patterns.length === 0) throw new Error("No protectable secret value was found")
      this.manual.set(entry.path, {
        entry,
        patterns,
        signature: `${info.mtimeMs}:${info.size}:${info.ino}`,
      })
    } catch (error) {
      this.manual.set(entry.path, {
        entry,
        patterns: [],
        invalid: error instanceof Error ? error.message : "File could not be read or parsed",
      })
    }
  }

  private async refreshManual() {
    let changed = false
    for (const [value, item] of this.manual) {
      if (item.entry.invalid) continue
      try {
        const info = await stat(value)
        if (!info.isFile()) throw new Error("Path is not a regular file")
        if (info.size > this.maxContentBytes) throw new Error("File exceeds maxContentBytes")
        const signature = `${info.mtimeMs}:${info.size}:${info.ino}`
        if (signature === item.signature) continue
        const content = await readFile(value, "utf8")
        const result = extractContent(content, item.entry.format, item.entry.keys, { strict: true })
        if (result.missing.length > 0) throw new Error(`Missing keys: ${result.missing.join(", ")}`)
        const patterns = patternsForValues(result.values)
        if (patterns.length === 0) throw new Error("No protectable secret value was found")
        this.manual.set(value, {
          entry: item.entry,
          patterns,
          signature,
        })
        changed = true
      } catch (error) {
        const invalid = error instanceof Error ? error.message : "File could not be read or parsed"
        if (item.invalid !== invalid) {
          this.manual.set(value, { entry: item.entry, patterns: [], invalid })
          changed = true
        }
      }
    }
    if (changed) this.notify()
  }

  private save() {
    this.saveQueue = this.saveQueue.then(() => this.write()).catch(() => {})
    return this.saveQueue
  }

  private async write() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    const file = path.join(this.directory, "registry.json")
    const temporary = path.join(this.directory, `.registry.${randomUUID()}.tmp`)
    const state: StoredState = {
      version: 3,
      manual: [...this.manual.values()].map((item) => item.entry),
      disabled: [...this.disabled.values()],
      pending: [...this.pending.values()],
    }
    try {
      await writeFile(temporary, JSON.stringify(state, null, 2), { mode: 0o600, flag: "wx" })
      await rename(temporary, file)
    } finally {
      await unlink(temporary).catch(() => {})
    }
  }
}

function sameLocation(left: LocationState, right: ReadonlyMap<string, LocationFile>) {
  if (left.files.size !== right.size) return false
  for (const [key, value] of right) {
    const existing = left.files.get(key)
    if (!existing || existing.source !== value.source || existing.invalid !== value.invalid || existing.keyCount !== value.keyCount) return false
    if (existing.format !== value.format || existing.label !== value.label) return false
    if (existing.keys.length !== value.keys.length || existing.keys.some((item, index) => item !== value.keys[index])) return false
  }
  return true
}

function manualFrom(value: unknown): ManualEntry | undefined {
  if (!value || typeof value !== "object") return
  const input = value as Record<string, unknown>
  if (typeof input.path !== "string" || typeof input.format !== "string" || typeof input.createdAt !== "number") return
  return {
    path: input.path,
    format: input.format as ExtractFormat,
    keys: Array.isArray(input.keys) ? input.keys.filter((item): item is string => typeof item === "string") : [],
    createdAt: input.createdAt,
    ...(typeof input.label === "string" ? { label: input.label } : {}),
    ...(typeof input.role === "string" ? { role: input.role } : {}),
    ...(typeof input.keyID === "string" ? { keyID: input.keyID } : {}),
    ...(typeof input.invalid === "string" ? { invalid: input.invalid } : {}),
  }
}

function disabledFrom(value: unknown): DisabledEntry | undefined {
  if (!value || typeof value !== "object") return
  const input = value as Record<string, unknown>
  if (typeof input.path !== "string" || typeof input.source !== "string" || typeof input.createdAt !== "number") return
  if (input.source !== "manual" && input.source !== "default" && input.source !== "config") return
  return {
    path: input.path,
    source: input.source,
    createdAt: input.createdAt,
    ...(typeof input.project === "string" ? { project: input.project } : {}),
    ...(typeof input.format === "string" ? { format: input.format as ExtractFormat } : {}),
    ...(Array.isArray(input.keys) ? { keys: input.keys.filter((item): item is string => typeof item === "string") } : {}),
    ...(typeof input.label === "string" ? { label: input.label } : {}),
  }
}

function pendingFrom(value: unknown): PendingRequest | undefined {
  if (!value || typeof value !== "object") return
  const input = value as Record<string, unknown>
  if (typeof input.id !== "string" || typeof input.path !== "string" || typeof input.source !== "string" || typeof input.createdAt !== "number") return
  if (input.source !== "manual" && input.source !== "default" && input.source !== "config") return
  return {
    id: input.id,
    path: input.path,
    source: input.source,
    createdAt: input.createdAt,
    ...(typeof input.project === "string" ? { project: input.project } : {}),
    ...(typeof input.sessionID === "string" ? { sessionID: input.sessionID } : {}),
    ...(typeof input.reason === "string" ? { reason: input.reason } : {}),
  }
}

async function migrateLegacy(value: unknown): Promise<ManualEntry | undefined> {
  if (!value || typeof value !== "object") return
  const input = value as Record<string, unknown>
  if (typeof input.path !== "string" || typeof input.createdAt !== "number") return
  let content: string
  try {
    content = await readFile(input.path, "utf8")
  } catch {
    return {
      path: input.path,
      format: "line",
      keys: [],
      createdAt: input.createdAt,
      ...(typeof input.label === "string" ? { label: input.label } : {}),
    }
  }
  if (isPrivateKey(content)) {
    return {
      path: input.path,
      format: "private-key",
      keys: [],
      createdAt: input.createdAt,
      ...(typeof input.label === "string" ? { label: input.label } : {}),
    }
  }
  const nonEmpty = content.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  if (nonEmpty.length === 1) {
    return {
      path: input.path,
      format: "line",
      keys: [],
      createdAt: input.createdAt,
      ...(typeof input.label === "string" ? { label: input.label } : {}),
    }
  }
  const format = detectFormat(input.path, content)
  if (format && format !== "line" && format !== "private-key") {
    return {
      path: input.path,
      format,
      keys: [],
      createdAt: input.createdAt,
      invalid: "Legacy multi-line manual entry must be re-registered with format and keys",
      ...(typeof input.label === "string" ? { label: input.label } : {}),
    }
  }
  return {
    path: input.path,
    format: "line",
    keys: [],
    createdAt: input.createdAt,
    invalid: "Legacy multi-line manual entry must be re-registered as a single-line secret, private key, or structured file",
    ...(typeof input.label === "string" ? { label: input.label } : {}),
  }
}
