export const DEFAULT_KEYBIND: string | false = false

export type Enabled = "auto" | boolean

export function resolveEnabled(value: unknown): Enabled {
  if (value === true || value === false) return value
  return "auto"
}

export function resolveKeybind(value: unknown): string | false {
  if (value === false) return false
  if (typeof value === "string" && value.trim()) return value.trim()
  return DEFAULT_KEYBIND
}

export function usageEnabled(options: Readonly<Record<string, unknown>>) {
  if (options.enabled === false) return false
  const features = options.features
  return !(isRecord(features) && features.opencodeGoUsage === false)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
