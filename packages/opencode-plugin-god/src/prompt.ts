import { readFile, stat } from "node:fs/promises"
import { homedir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

export type PromptLoad = {
  readonly source: string
  readonly text?: string
  readonly error?: string
}

type LocalCacheEntry = {
  readonly text: string
  readonly mtimeMs: number
  readonly size: number
}

type HttpCacheEntry = {
  readonly text: string
  readonly at: number
}

export type PromptLoaderOptions = {
  readonly directory: string
  readonly cache: boolean
  readonly cacheTtlMs: number
  readonly timeoutMs: number
  readonly home?: string
  readonly fetchImpl?: typeof fetch
}

/**
 * Loads prompt text from a local path or an HTTP(S) URL and keeps a small
 * cache. Local files are revalidated with stat; remote files use a TTL.
 */
export class PromptLoader {
  private readonly local = new Map<string, LocalCacheEntry>()
  private readonly remote = new Map<string, HttpCacheEntry>()

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
    if (this.options.cache) {
      const cached = this.remote.get(url)
      if (cached && Date.now() - cached.at < this.options.cacheTtlMs) {
        return { source, text: cached.text }
      }
    }

    const fetchImpl = this.options.fetchImpl ?? fetch
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(this.options.timeoutMs) })
    if (!response.ok) return { source, error: `HTTP ${response.status} ${response.statusText}`.trim() }

    const text = await response.text()
    if (this.options.cache) this.remote.set(url, { text, at: Date.now() })
    return { source, text }
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
