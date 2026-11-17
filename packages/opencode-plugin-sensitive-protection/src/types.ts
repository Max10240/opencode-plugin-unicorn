export type ProtectionSource = "manual" | "default" | "config"

export type ProtectionPattern = {
  readonly value: string
  readonly key?: string
}

export type ProtectionMatch = {
  readonly file?: string
  readonly label?: string
  readonly source?: ProtectionSource
  readonly key?: string
  readonly count: number
}

export type ProtectionHit = {
  /** Stable across repeat occurrences of the same condition. */
  readonly id: string
  /** Last time this condition fired. */
  readonly time: number
  /** First time this condition fired. */
  readonly firstTime: number
  /** Number of times this condition fired while it stayed aggregated. */
  readonly occurrences: number
  readonly kind: "blocked" | "redacted" | "error"
  readonly source: "read" | "tool" | "context" | "http" | "parser"
  readonly count: number
  readonly label?: string
  readonly file?: string
  readonly tool?: string
  readonly sessionID?: string
  /** Short, user-facing cause for parser or configuration errors. */
  readonly detail?: string
  readonly matches?: readonly ProtectionMatch[]
}

export type ProtectionHitInput = Omit<ProtectionHit, "id" | "time" | "firstTime" | "occurrences">
