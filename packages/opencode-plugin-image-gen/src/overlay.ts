export function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function mergeOverlay(base: Readonly<Record<string, unknown>> = {}, overlay: Readonly<Record<string, unknown>> = {}): Record<string, unknown> {
  return Object.fromEntries([...new Set([...Object.keys(base), ...Object.keys(overlay)])].map((key) => {
    const left = Object.hasOwn(base, key) ? base[key] : undefined
    const right = Object.hasOwn(overlay, key) ? overlay[key] : undefined
    return [key, right === undefined ? left : record(left) && record(right) ? mergeOverlay(left, right) : right]
  }))
}

export function mergeHeaders(base: Readonly<Record<string, string>> = {}, overlay: Readonly<Record<string, string>> = {}) {
  const values = new Map<string, [string, string]>()
  for (const entry of [...Object.entries(base), ...Object.entries(overlay)]) values.set(entry[0].toLowerCase(), entry)
  return Object.fromEntries(values.values())
}
