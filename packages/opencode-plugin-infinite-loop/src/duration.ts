export const SECOND_MS = 1_000
export const MINUTE_MS = 60_000
export const HOUR_MS = 3_600_000
export const DAY_MS = 86_400_000

const UNIT_MS: Record<Unit, number> = { s: SECOND_MS, m: MINUTE_MS, h: HOUR_MS, d: DAY_MS }
type Unit = "s" | "m" | "h" | "d"

export type DurationBounds = {
  readonly minMs: number
  readonly maxMs: number
}

export type DurationParse = { readonly ok: true; readonly ms: number } | { readonly ok: false; readonly error: string }

const INVALID = (input: string) =>
  `"${input}" is not a valid duration; use 90m, 2h, 1h30m, 1d, or a bare number of hours`

/**
 * Parses a duration: `<number><s|m|h|d>` with optional compound units such as `1h30m`.
 * A bare number is treated as hours, matching the preset scale.
 */
export function parseDuration(input: string, bounds: DurationBounds): DurationParse {
  return parseUnits(input, bounds, HOUR_MS, "hours")
}

/**
 * Parses a cooldown. Unlike a duration, a bare number is minutes (`5` = 5m) and
 * zero is accepted when the lower bound allows it.
 */
export function parseCooldown(input: string, bounds: DurationBounds): DurationParse {
  const text = input.trim().toLowerCase()
  if (/^0+(?:\.0+)?$/.test(text)) {
    if (bounds.minMs > 0) return { ok: false, error: `Cooldown must be at least ${formatDuration(bounds.minMs)}` }
    return { ok: true, ms: 0 }
  }
  return parseUnits(input, bounds, MINUTE_MS, "minutes")
}

function parseUnits(input: string, bounds: DurationBounds, bareUnitMs: number, bareLabel: string): DurationParse {
  const text = input.trim().toLowerCase()
  if (!text) {
    return {
      ok: false,
      error: `Enter a duration like 90m, 2h, 1h30m, or a bare number of ${bareLabel}`,
    }
  }
  let ms = 0
  let index = 0
  while (index < text.length) {
    const match = /^(\d+(?:\.\d+)?)\s*(s|m|h|d)?/.exec(text.slice(index))
    if (!match) return { ok: false, error: INVALID(input) }
    const value = Number(match[1])
    if (!Number.isFinite(value) || value < 0) return { ok: false, error: INVALID(input) }
    if (value === 0 && index === 0 && text.length === match[0].length) {
      if (bounds.minMs > 0) return { ok: false, error: `Duration must be at least ${formatDuration(bounds.minMs)}` }
      return { ok: true, ms: 0 }
    }
    if (value <= 0) return { ok: false, error: INVALID(input) }
    const unit = (match[2] ?? null) as Unit | null
    ms += value * (unit === null ? bareUnitMs : UNIT_MS[unit])
    index += match[0].length
  }
  const total = Math.round(ms)
  if (total < bounds.minMs) return { ok: false, error: `Duration must be at least ${formatDuration(bounds.minMs)}` }
  if (total > bounds.maxMs) return { ok: false, error: `Duration must be at most ${formatDuration(bounds.maxMs)}` }
  return { ok: true, ms: total }
}

/** Formats a duration as a compact human string: `2d 12h`, `1h 30m`, `45m`, `30s`. */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms))
  if (total <= 0) return "0s"
  if (total < MINUTE_MS) return `${Math.round(total / 1000)}s`
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
