export const MINUTE_MS = 60_000
export const HOUR_MS = 3_600_000
export const DAY_MS = 86_400_000

const UNIT_MS: Record<Unit, number> = { m: MINUTE_MS, h: HOUR_MS, d: DAY_MS }
type Unit = "m" | "h" | "d"

export type DurationBounds = {
  readonly minMs: number
  readonly maxMs: number
}

export type DurationParse = { readonly ok: true; readonly ms: number } | { readonly ok: false; readonly error: string }

const INVALID = (input: string) =>
  `"${input}" is not a valid duration; use 90m, 2h, 1h30m, 1d, or a bare number of hours`

/**
 * Parses a duration: `<number><m|h|d>` with optional compound units such as `1h30m`.
 * A bare number is treated as hours, matching the preset scale.
 */
export function parseDuration(input: string, bounds: DurationBounds): DurationParse {
  const text = input.trim().toLowerCase()
  if (!text) return { ok: false, error: "Enter a duration like 90m, 2h, 1h30m, or a bare number of hours" }
  let ms = 0
  let index = 0
  while (index < text.length) {
    const match = /^(\d+(?:\.\d+)?)\s*(m|h|d)?/.exec(text.slice(index))
    if (!match) return { ok: false, error: INVALID(input) }
    const value = Number(match[1])
    if (!Number.isFinite(value) || value <= 0) return { ok: false, error: INVALID(input) }
    const unit = (match[2] ?? "h") as Unit
    ms += value * UNIT_MS[unit]
    index += match[0].length
  }
  const total = Math.round(ms)
  if (total < bounds.minMs) return { ok: false, error: `Dead loop duration must be at least ${formatDuration(bounds.minMs)}` }
  if (total > bounds.maxMs) return { ok: false, error: `Dead loop duration must be at most ${formatDuration(bounds.maxMs)}` }
  return { ok: true, ms: total }
}

/** Formats a duration as a compact human string: `2d 12h`, `1h 30m`, `45m`, `30s`. */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms))
  if (total <= 0) return "0s"
  if (total < 60_000) return `${Math.round(total / 1000)}s`
  const minutes = Math.round(total / MINUTE_MS)
  const days = Math.floor(minutes / (24 * 60))
  const hours = Math.floor((minutes % (24 * 60)) / 60)
  const rest = minutes % 60
  const parts: string[] = []
  if (days > 0) parts.push(`${days}d`)
  if (hours > 0) parts.push(`${hours}h`)
  if (rest > 0 || parts.length === 0) parts.push(`${rest}m`)
  return parts.join(" ")
}

/** Parses a preset list, dropping entries that do not parse or fall outside the bounds. */
export function parsePresets(raw: unknown, bounds: DurationBounds): readonly string[] {
  if (!Array.isArray(raw)) return []
  const seen = new Set<string>()
  const presets: string[] = []
  for (const entry of raw) {
    if (typeof entry !== "string") continue
    const value = entry.trim()
    if (!value || seen.has(value.toLowerCase())) continue
    if (!parseDuration(value, bounds).ok) continue
    seen.add(value.toLowerCase())
    presets.push(value)
  }
  return presets
}
