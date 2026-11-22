import { readFile, stat } from "node:fs/promises"
import { homedir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

export type PromptLoad = {
  readonly source: string
  readonly text?: string
  readonly error?: string
}

/**
 * Minimal key/value slot matching the plugin context storage. Values are
 * strings so the entry stays a valid storage value without serialization
 * concerns.
 */
export type PromptCacheSlot = {
  readonly get: (key: string) => Promise<unknown>
  readonly set: (key: string, value: string) => Promise<unknown>
}

type LocalCacheEntry = {
  readonly text: string
  readonly mtimeMs: number
  readonly size: number
}

type RemoteCacheEntry = {
  readonly text: string
  readonly fetchedAt: number
}

export type PromptLoaderOptions = {
  readonly directory: string
  readonly cache: boolean
  readonly cacheTtlMs: number
  readonly timeoutMs: number
  readonly storage?: PromptCacheSlot
  readonly home?: string
  readonly now?: () => number
  readonly fetchImpl?: typeof fetch
}

const CACHE_PREFIX = "god:prompt:v1:"
const RETRY_MS = 300_000

/**
 * Loads prompt text from a local path or an HTTP(S) URL. Local files are
 * revalidated with stat. Remote prompts are cached in memory and in plugin
 * storage; a stale entry is served immediately and refreshed in the
 * background, so a request never waits on the network once a copy exists.
 * A source that just failed is not retried for RETRY_MS, so an unreachable
 * host cannot add a timeout to every request.
 */
export class PromptLoader {
  private readonly local = new Map<string, LocalCacheEntry>()
  private readonly remote = new Map<string, RemoteCacheEntry>()
  private readonly inflight = new Map<string, Promise<PromptLoad>>()
  private readonly retryAt = new Map<string, number>()

  constructor(private readonly options: PromptLoaderOptions) {}

  async load(source: string): Promise<PromptLoad> {
    try {
      const target = parseSource(source, this.options.directory, this.options.home)
      if (target.kind === "http") return await this.loadRemote(source, target.url)
      return await this.loadLocal(source, target.filepath)
    } catch (error) {
      return { source, error: error instanceof Error ? error.message : String(error) }
    }
  }

  private async loadLocal(source: string, filepath: string): Promise<PromptLoad> {
    const info = await stat(filepath)
    if (!info.isFile()) return { source, error: `not a file: ${filepath}` }

    if (this.options.cache) {
      const cached = this.local.get(filepath)
      if (cached && cached.mtimeMs === info.mtimeMs && cached.size === info.size) {
        return { source, text: cached.text }
      }
    }

    const text = await readFile(filepath, "utf8")
    if (this.options.cache) {
      this.local.set(filepath, { text, mtimeMs: info.mtimeMs, size: info.size })
    }
    return { source, text }
  }

  private async loadRemote(source: string, url: string): Promise<PromptLoad> {
    if (!this.options.cache) return this.download(source, url, false)

    const cached = this.remote.get(url)
    if (cached) {
      if (this.stale(cached.fetchedAt)) void this.refresh(url)
      return { source, text: cached.text }
    }

    const stored = await this.read(url)
    if (stored) {
      this.remote.set(url, stored)
      if (this.stale(stored.fetchedAt)) void this.refresh(url)
      return { source, text: stored.text }
    }

    if (this.blocked(url)) {
      return { source, error: `recent load failed, retrying in under ${Math.round(RETRY_MS / 1000)}s` }
    }
    return this.download(source, url, true)
  }

  private blocked(url: string): boolean {
    const retryAt = this.retryAt.get(url)
    return retryAt !== undefined && this.now() < retryAt
  }

  private stale(fetchedAt: number): boolean {
    return this.now() - fetchedAt >= this.options.cacheTtlMs
  }

  private now(): number {
    return this.options.now ? this.options.now() : Date.now()
  }

  private refresh(url: string): Promise<PromptLoad> {
    if (this.blocked(url)) return Promise.resolve({ source: url, error: "recent load failed" })
    return this.download(url, url, true)
  }

  private download(source: string, url: string, persist: boolean): Promise<PromptLoad> {
    const running = this.inflight.get(url)
    if (running) return running.then((result) => ({ ...result, source }))

    const task = this.fetch(url, persist)
      .catch((error): PromptLoad => ({ source: url, error: error instanceof Error ? error.message : String(error) }))
      .then((result) => {
        // Remember failures so a dead source does not add a timeout to every request.
        if (result.error) this.retryAt.set(url, this.now() + RETRY_MS)
        else this.retryAt.delete(url)
        return result
      })
      .finally(() => this.inflight.delete(url))
    this.inflight.set(url, task)
    return task.then((result) => ({ ...result, source }))
  }

  private async fetch(url: string, persist: boolean): Promise<PromptLoad> {
    const fetchImpl = this.options.fetchImpl ?? fetch
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(this.options.timeoutMs) })
    if (!response.ok) return { source: url, error: `HTTP ${response.status} ${response.statusText}`.trim() }

    const text = await response.text()
    // A blank body is useless as a system prompt and is not worth caching.
    if (!text.trim()) return { source: url, error: "empty response" }
    if (persist) {
      const fetchedAt = this.now()
      this.remote.set(url, { text, fetchedAt })
      // Persisted before returning so a restart right after the request still
      // finds the prompt. A storage failure is swallowed by write().
      await this.write(url, { text, fetchedAt })
    }
    return { source: url, text }
  }

  private async read(url: string): Promise<RemoteCacheEntry | undefined> {
    const storage = this.options.storage
    if (!storage) return undefined
    try {
      const raw = await storage.get(`${CACHE_PREFIX}${url}`)
      if (typeof raw !== "string") return undefined
      const parsed = JSON.parse(raw) as { text?: unknown; fetchedAt?: unknown }
      if (typeof parsed.text !== "string" || typeof parsed.fetchedAt !== "number") return undefined
      if (!parsed.text.trim()) return undefined
      return { text: parsed.text, fetchedAt: parsed.fetchedAt }
    } catch {
      return undefined
    }
  }

  private async write(url: string, entry: RemoteCacheEntry): Promise<void> {
    const storage = this.options.storage
    if (!storage) return
    try {
      await storage.set(`${CACHE_PREFIX}${url}`, JSON.stringify(entry))
    } catch {
      // A cache write failure must never fail the request.
    }
  }
}

type ParsedSource = { readonly kind: "http"; readonly url: string } | { readonly kind: "file"; readonly filepath: string }

/**
 * Supports HTTP(S) URLs, file URLs, absolute paths, `~/` paths, and paths
 * relative to the workspace directory.
 */
export function parseSource(source: string, directory: string, home = homedir()): ParsedSource {
  const value = source.trim()
  const url = parseUrl(value)
  if (url) {
    if (url.protocol === "http:" || url.protocol === "https:") return { kind: "http", url: url.toString() }
    if (url.protocol === "file:") return { kind: "file", filepath: fileURLToPath(url) }
  }

  const expanded = expandHome(value, home)
  return { kind: "file", filepath: path.isAbsolute(expanded) ? expanded : path.resolve(directory, expanded) }
}

export function expandHome(source: string, home = homedir()): string {
  if (source === "~") return home
  if (source.startsWith("~/") || source.startsWith("~\\")) return path.join(home, source.slice(2))
  return source
}

function parseUrl(source: string): URL | undefined {
  try {
    return new URL(source)
  } catch {
    return undefined
  }
}
