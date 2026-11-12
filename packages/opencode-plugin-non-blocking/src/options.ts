export const DEFAULT_THRESHOLD_MS = 10_000

export function nonBlockingEnabled(options: Readonly<Record<string, unknown>>) {
  if (options.enabled === false) return false
  const features = options.features
  return !(isRecord(features) && features.nonBlocking === false)
}

export function resolveThreshold(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) return Math.floor(value)
  return DEFAULT_THRESHOLD_MS
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
