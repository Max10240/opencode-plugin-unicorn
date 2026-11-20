export const DEFAULT_KEYBIND = "<leader>d"
export const DEFAULT_QUEUE_KEYBIND = "f9"
export const DEFAULT_RECHECK_MS = 5_000
export const MIN_RECHECK_MS = 1_000
export const MAX_RECHECK_MS = 10 * 60_000

export const WAIT_KINDS = ["shell", "subagent", "image", "video", "codemode"] as const
export type WaitKind = (typeof WAIT_KINDS)[number]

export type DelayedQueueOptions = {
  readonly enabled: boolean
  readonly keybind: string | false
  readonly queueKeybind: string | false
  readonly recheckMs: number
  readonly waitKinds: readonly WaitKind[]
  readonly waitDescendants: boolean
  readonly pauseOnInterrupt: boolean
  readonly pauseOnFailure: boolean
}

export function delayedQueueEnabled(raw: Readonly<Record<string, unknown>> = {}): boolean {
  if (raw.enabled === false) return false
  const features = raw.features
  return !(isRecord(features) && features.delayedQueue === false)
}

export function parseDelayedQueueOptions(raw: Readonly<Record<string, unknown>> = {}): DelayedQueueOptions {
  return {
    enabled: delayedQueueEnabled(raw),
    keybind: readKeybind(raw.keybind),
    queueKeybind: readKeybind(raw.queueKeybind, DEFAULT_QUEUE_KEYBIND),
    recheckMs: readInteger(raw.recheckMs, "recheckMs", MIN_RECHECK_MS, MAX_RECHECK_MS, DEFAULT_RECHECK_MS),
    waitKinds: readKinds(raw.waitKinds),
    waitDescendants: readBoolean(raw.waitDescendants, "waitDescendants", true),
    pauseOnInterrupt: readBoolean(raw.pauseOnInterrupt, "pauseOnInterrupt", true),
    pauseOnFailure: readBoolean(raw.pauseOnFailure, "pauseOnFailure", true),
  }
}

function readKeybind(raw: unknown, fallback = DEFAULT_KEYBIND): string | false {
  if (raw === undefined) return fallback
  if (raw === false) return false
  if (typeof raw !== "string" || !raw.trim()) throw new Error("keybind must be a non-empty string or false")
  return raw.trim()
}

function readInteger(raw: unknown, name: string, min: number, max: number, fallback: number): number {
  if (raw === undefined) return fallback
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw < min || raw > max) {
    throw new Error(`${name} must be a number between ${min} and ${max}`)
  }
  return Math.floor(raw)
}

function readBoolean(raw: unknown, name: string, fallback: boolean): boolean {
  if (raw === undefined) return fallback
  if (typeof raw !== "boolean") throw new Error(`${name} must be a boolean`)
  return raw
}

function readKinds(raw: unknown): readonly WaitKind[] {
  if (raw === undefined) return WAIT_KINDS
  if (!Array.isArray(raw)) throw new Error("waitKinds must be an array")
  const seen = new Set<WaitKind>()
  for (const entry of raw) {
    if (typeof entry !== "string" || !(WAIT_KINDS as readonly string[]).includes(entry)) {
      throw new Error(`waitKinds contains an unknown kind: ${JSON.stringify(entry)}`)
    }
    seen.add(entry as WaitKind)
  }
  return [...seen]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
