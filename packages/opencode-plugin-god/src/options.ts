import {
  DEFAULT_FALLBACK_PATH,
  DEFAULT_FAMILY_PATHS,
  DEFAULT_MODEL_PATHS,
  DEFAULT_SOURCE_BASE,
  FALLBACK_MODEL_KEY,
} from "./defaults.js"

export const GOD_AGENT_ID = "god"
export const DEFAULT_CACHE_TTL_MS = 86_400_000
export const DEFAULT_TIMEOUT_MS = 10_000

export type ResolvedGodOptions = {
  readonly models: ReadonlyMap<string, string>
  readonly defaults: ReadonlyMap<string, string>
  readonly families: ReadonlyArray<readonly [string, string]>
  readonly fallback: string
  readonly cache: boolean
  readonly cacheTtlMs: number
  readonly timeoutMs: number
  readonly sourceBaseUrl: string
}

/**
 * Reads the plugin options. Unknown fields are ignored so the plugin can
 * share an options object with the rest of the Unicorn bundle. User entries
 * always win over the built-in table.
 */
export function parseGodOptions(value: unknown): ResolvedGodOptions {
  const source = isRecord(value) ? value : {}
  const models = new Map<string, string>()

  if (isRecord(source.models)) {
    for (const [rawModel, rawPrompt] of Object.entries(source.models)) {
      if (typeof rawPrompt !== "string") continue
      const model = rawModel.trim()
      const prompt = rawPrompt.trim()
      if (!model || !prompt) continue
      models.set(model, prompt)
    }
  }

  const sourceBaseUrl = baseUrl(source.sourceBaseUrl)
  const defaults = new Map<string, string>()
  for (const [model, target] of Object.entries(DEFAULT_MODEL_PATHS)) defaults.set(model, `${sourceBaseUrl}${target}`)
  const families = DEFAULT_FAMILY_PATHS.map(([prefix, target]) => [prefix, `${sourceBaseUrl}${target}`] as const)

  return {
    models,
    defaults,
    families,
    fallback: `${sourceBaseUrl}${DEFAULT_FALLBACK_PATH}`,
    cache: typeof source.cache === "boolean" ? source.cache : true,
    cacheTtlMs: positiveNumber(source.cacheTtlMs) ?? DEFAULT_CACHE_TTL_MS,
    timeoutMs: positiveNumber(source.timeoutMs) ?? DEFAULT_TIMEOUT_MS,
    sourceBaseUrl,
  }
}

export type PromptSources = {
  readonly source: string
  readonly fallback?: string
}

/** Providers expose free variants of the same model under a suffixed id. */
const FREE_SUFFIX = /(?:-free|:free)$/

/**
 * Selects the prompt sources for a model ID. User entries are checked first,
 * then the built-in table, then family prefixes, then the built-in fallback.
 * A built-in match also reports the shared fallback, so a missing upstream
 * file degrades to the generic prompt instead of being ignored.
 */
export function selectPromptSources(
  options: ResolvedGodOptions,
  modelID: string,
  providerID?: string,
): PromptSources {
  if (providerID) {
    const scoped = options.models.get(`${providerID}/${modelID}`)
    if (scoped) return { source: scoped }
  }

  const exact = options.models.get(modelID)
  if (exact) return { source: exact }

  const wildcard = options.models.get(FALLBACK_MODEL_KEY)
  if (wildcard) return { source: wildcard }

  const builtin = options.defaults.get(modelID) ?? options.defaults.get(modelID.replace(FREE_SUFFIX, ""))
  if (builtin) return { source: builtin, fallback: options.fallback }

  for (const [prefix, target] of options.families) {
    if (modelID.startsWith(prefix)) return { source: target, fallback: options.fallback }
  }

  return { source: options.fallback }
}

export function selectPromptSource(
  options: ResolvedGodOptions,
  modelID: string,
  providerID?: string,
): string {
  return selectPromptSources(options, modelID, providerID).source
}

function baseUrl(value: unknown): string {
  const raw = typeof value === "string" ? value.trim() : ""
  const base = raw.replace(/\/+$/, "") || DEFAULT_SOURCE_BASE.replace(/\/+$/, "")
  return `${base}/`
}

function positiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
