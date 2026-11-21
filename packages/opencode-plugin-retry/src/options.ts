export const DEFAULT_KEYBIND = "f5"
export const DEFAULT_CONTINUE_TEXT = "Continue"
export const DEFAULT_INTERRUPT_TIMEOUT_MS = 1_000

export type RetryOptions = {
  readonly enabled: boolean
  readonly keybind: string | false
  readonly continueText: string
}

export function retryEnabled(raw: Readonly<Record<string, unknown>> = {}): boolean {
  if (raw.enabled === false) return false
  const features = raw.features
  return !(isRecord(features) && features.retry === false)
}

export function parseRetryOptions(raw: Readonly<Record<string, unknown>> = {}): RetryOptions {
  return {
    enabled: retryEnabled(raw),
    keybind: readKeybind(raw.keybind),
    continueText: readContinueText(raw.continueText),
  }
}

function readKeybind(value: unknown): string | false {
  if (value === undefined) return DEFAULT_KEYBIND
  if (value === false) return false
  if (typeof value !== "string" || !value.trim()) throw new Error("keybind must be a non-empty string or false")
  return value.trim()
}

function readContinueText(value: unknown): string {
  if (value === undefined) return DEFAULT_CONTINUE_TEXT
  if (typeof value !== "string") throw new Error("continueText must be a non-empty string")
  const text = value.trim()
  if (!text) throw new Error("continueText must be a non-empty string")
  return text
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
