export const GOD_AGENT_ID = "god"
export const FALLBACK_MODEL_KEY = "*"
export const DEFAULT_CACHE_TTL_MS = 60_000
export const DEFAULT_TIMEOUT_MS = 10_000

export type ResolvedGodOptions = {
  readonly models: ReadonlyMap<string, string>
  readonly cache: boolean
  readonly cacheTtlMs: number
  readonly timeoutMs: number
}

/**
 * Reads the plugin options. Unknown fields are ignored so the plugin can
 * share an options object with the rest of the Unicorn bundle.
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

  return {
    models,
    cache: typeof source.cache === "boolean" ? source.cache : true,
    cacheTtlMs: positiveNumber(source.cacheTtlMs) ?? DEFAULT_CACHE_TTL_MS,
    timeoutMs: positiveNumber(source.timeoutMs) ?? DEFAULT_TIMEOUT_MS,
  }
}

/**
 * Selects a prompt source for a model ID. The provider is deliberately not
 * part of the key: the same model served by two providers maps to one prompt.
 */
export function selectPromptSource(options: ResolvedGodOptions, modelID: string): string | undefined {
  const exact = options.models.get(modelID)
  if (exact) return exact
  return options.models.get(FALLBACK_MODEL_KEY)
}

function positiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
