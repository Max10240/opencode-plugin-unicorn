export interface UnicornOptions {
  readonly recommendedOpencodeConfig?: Readonly<Record<string, unknown>>
  readonly god?: Readonly<Record<string, unknown>>
  readonly sendMessageAcrossSessions?: Readonly<Record<string, unknown>>
  readonly imageGen?: Readonly<Record<string, unknown>>
  readonly notepad?: Readonly<Record<string, unknown>>
  readonly showImg?: Readonly<Record<string, unknown>>
  readonly promptSearch?: Readonly<Record<string, unknown>>
  readonly sensitiveEncrypt?: Readonly<Record<string, unknown>>
  readonly sensitiveProtection?: Readonly<Record<string, unknown>>
  readonly sessionSearch?: Readonly<Record<string, unknown>>
  readonly nonBlocking?: Readonly<Record<string, unknown>>
  readonly opencodeGoUsage?: Readonly<Record<string, unknown>>
  readonly deadLoop?: Readonly<Record<string, unknown>>
  readonly delayedQueue?: Readonly<Record<string, unknown>>
  readonly features?: {
    readonly recommendedOpencodeConfig?: boolean
    readonly god?: boolean
    readonly sendMessageAcrossSessions?: boolean
    readonly imageGen?: boolean
    readonly notepad?: boolean
    readonly showImg?: boolean
    readonly promptSearch?: boolean
    readonly sensitiveEncrypt?: boolean
    readonly sensitiveProtection?: boolean
    readonly sessionSearch?: boolean
    readonly nonBlocking?: boolean
    readonly opencodeGoUsage?: boolean
    readonly deadLoop?: boolean
    readonly delayedQueue?: boolean
  }
}

export type ChildPlugin = Exclude<keyof UnicornOptions, "features">

export function childContext<T extends { readonly options: Readonly<Record<string, unknown>> }>(context: T, plugin: ChildPlugin): Omit<T, "options"> & { readonly options: Readonly<Record<string, unknown>> } {
  const options = context.options[plugin]
  // Keep host getters live without mutating the context shared by sibling plugins.
  return Object.create(context, { options: { value: isRecord(options) ? options : {}, enumerable: true } })
}

export function recommendedConfigFeatureOption(options: Readonly<Record<string, unknown>>): boolean | undefined {
  const features = options.features
  return isRecord(features) && typeof features.recommendedOpencodeConfig === "boolean" ? features.recommendedOpencodeConfig : undefined
}

// Opt-in: enable with features.god: true or by providing a god options object.
// features.god: false always wins.
export function godFeatureEnabled(options: Readonly<Record<string, unknown>>): boolean {
  const features = options.features
  if (isRecord(features) && features.god === false) return false
  if (isRecord(features) && features.god === true) return true
  return isRecord(options.god)
}

export function sendMessageAcrossSessionsFeatureEnabled(options: Readonly<Record<string, unknown>>): boolean {
  const features = options.features
  return !isRecord(features) || features.sendMessageAcrossSessions !== false
}

export function imageGenFeatureEnabled(options: Readonly<Record<string, unknown>>): boolean {
  const features = options.features
  return !isRecord(features) || features.imageGen !== false
}

export function notepadFeatureEnabled(options: Readonly<Record<string, unknown>>): boolean {
  const features = options.features
  return !isRecord(features) || features.notepad !== false
}

export function promptSearchFeatureEnabled(options: Readonly<Record<string, unknown>>): boolean {
  const features = options.features
  return !isRecord(features) || features.promptSearch !== false
}

// Enabled by default; set features.sensitiveEncrypt to false to disable it.
export function sensitiveEncryptFeatureEnabled(options: Readonly<Record<string, unknown>>): boolean {
  const features = options.features
  return !isRecord(features) || features.sensitiveEncrypt !== false
}

// Enabled by default; set features.sensitiveProtection to false to disable it.
export function sensitiveProtectionFeatureEnabled(options: Readonly<Record<string, unknown>>): boolean {
  const features = options.features
  return !isRecord(features) || features.sensitiveProtection !== false
}

export function sessionSearchFeatureEnabled(options: Readonly<Record<string, unknown>>): boolean {
  const features = options.features
  return !isRecord(features) || features.sessionSearch !== false
}

export function nonBlockingFeatureEnabled(options: Readonly<Record<string, unknown>>): boolean {
  const features = options.features
  return !isRecord(features) || features.nonBlocking !== false
}

export function showImgFeatureEnabled(options: Readonly<Record<string, unknown>>): boolean {
  const features = options.features
  return !isRecord(features) || features.showImg !== false
}

export function opencodeGoUsageFeatureEnabled(options: Readonly<Record<string, unknown>>): boolean {
  const features = options.features
  return !isRecord(features) || features.opencodeGoUsage !== false
}

export function deadLoopFeatureEnabled(options: Readonly<Record<string, unknown>>): boolean {
  const features = options.features
  return !isRecord(features) || features.deadLoop !== false
}

export function delayedQueueFeatureEnabled(options: Readonly<Record<string, unknown>>): boolean {
  const features = options.features
  return !isRecord(features) || features.delayedQueue !== false
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
