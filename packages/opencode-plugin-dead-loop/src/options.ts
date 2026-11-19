import { DAY_MS, MINUTE_MS, parsePresets } from "./duration.js"

export const DEFAULT_MESSAGE =
  "Keep working without asking any questions. Do not stop until you have finished everything you need to do."
export const DEFAULT_DELAY_MS = 3_000
export const DEFAULT_RECHECK_MS = 15_000
export const DEFAULT_MIN_DURATION_MS = 5 * MINUTE_MS
export const DEFAULT_MAX_DURATION_MS = 7 * DAY_MS
export const DEFAULT_PRESETS: readonly string[] = ["15m", "1h", "2h", "3h", "8h", "1d"]
export const DEFAULT_KEYBIND = "ctrl+shift+l"
export const DEFAULT_DURATION_MS = 60 * MINUTE_MS

export const MIN_DELAY_MS = 100
export const MAX_DELAY_MS = 10 * MINUTE_MS
export const MIN_RECHECK_MS = 1_000
export const MAX_RECHECK_MS = 10 * MINUTE_MS
export const MIN_DURATION_FLOOR_MS = 1_000
export const MAX_DURATION_CEILING_MS = 30 * DAY_MS

export type DeadLoopOptions = {
  readonly enabled: boolean
  readonly message: string
  readonly delayMs: number
  readonly recheckMs: number
  readonly minDurationMs: number
  readonly maxDurationMs: number
  readonly defaultDurationMs: number
  readonly presets: readonly string[]
  readonly keybind: string | false
}

export function deadLoopEnabled(raw: Readonly<Record<string, unknown>>): boolean {
  if (raw.enabled === false) return false
  const features = raw.features
  return !(isRecord(features) && features.deadLoop === false)
}

export function parseDeadLoopOptions(raw: Readonly<Record<string, unknown>> = {}): DeadLoopOptions {
  const message = readMessage(raw.message)
  const delayMs = readInteger(raw.delayMs, "delayMs", MIN_DELAY_MS, MAX_DELAY_MS, DEFAULT_DELAY_MS)
  const recheckMs = readInteger(raw.recheckMs, "recheckMs", MIN_RECHECK_MS, MAX_RECHECK_MS, DEFAULT_RECHECK_MS)
  const minDurationMs = readInteger(
    raw.minDurationMs,
    "minDurationMs",
    MIN_DURATION_FLOOR_MS,
    MAX_DURATION_CEILING_MS,
    DEFAULT_MIN_DURATION_MS,
  )
  const maxDurationMs = readInteger(
    raw.maxDurationMs,
    "maxDurationMs",
    minDurationMs,
    MAX_DURATION_CEILING_MS,
    DEFAULT_MAX_DURATION_MS,
  )
  const presets = readPresets(raw.presets, { minMs: MIN_DURATION_FLOOR_MS, maxMs: MAX_DURATION_CEILING_MS })
  const defaultDurationMs = readInteger(
    raw.defaultDurationMs,
    "defaultDurationMs",
    minDurationMs,
    maxDurationMs,
    DEFAULT_DURATION_MS,
  )
  const keybind = readKeybind(raw.keybind)
  return {
    enabled: deadLoopEnabled(raw),
    message,
    delayMs,
    recheckMs,
    minDurationMs,
    maxDurationMs,
    defaultDurationMs,
    presets,
    keybind,
  }
}

function readMessage(raw: unknown): string {
  if (raw === undefined) return DEFAULT_MESSAGE
  if (typeof raw !== "string" || !raw.trim()) throw new Error("message must be a non-empty string")
  return raw
}

function readInteger(raw: unknown, name: string, min: number, max: number, fallback: number): number {
  if (raw === undefined) return fallback
  if (typeof raw !== "number" || !Number.isSafeInteger(raw) || raw < min || raw > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`)
  }
  return raw
}

function readPresets(raw: unknown, bounds: { minMs: number; maxMs: number }): readonly string[] {
  if (raw === undefined) return DEFAULT_PRESETS
  if (!Array.isArray(raw)) throw new Error("presets must be an array of duration strings")
  const seen = new Set<string>()
  const presets: string[] = []
  const invalid: string[] = []
  for (const entry of raw) {
    const value = typeof entry === "string" ? entry.trim() : ""
    if (!value || !parsePresets([value], bounds).length || seen.has(value.toLowerCase())) {
      invalid.push(JSON.stringify(entry))
      continue
    }
    seen.add(value.toLowerCase())
    presets.push(value)
  }
  if (invalid.length) throw new Error(`presets contains invalid or duplicate durations: ${invalid.join(", ")}`)
  return presets
}

function readKeybind(raw: unknown): string | false {
  if (raw === undefined) return DEFAULT_KEYBIND
  if (raw === false) return false
  if (typeof raw !== "string" || !raw.trim()) throw new Error("keybind must be a non-empty string or false")
  return raw.trim()
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
