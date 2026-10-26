export interface UnicornOptions {
  readonly recommendedOpencodeConfig?: Readonly<Record<string, unknown>>
  readonly sendMessageAcrossSessions?: Readonly<Record<string, unknown>>
  readonly imageGen?: Readonly<Record<string, unknown>>
  readonly showImg?: Readonly<Record<string, unknown>>
  readonly promptSearch?: Readonly<Record<string, unknown>>
  readonly sensitiveEncrypt?: Readonly<Record<string, unknown>>
  readonly sessionSearch?: Readonly<Record<string, unknown>>
  readonly features?: {
    readonly recommendedOpencodeConfig?: boolean
    readonly sendMessageAcrossSessions?: boolean
    readonly imageGen?: boolean
    readonly showImg?: boolean
    readonly promptSearch?: boolean
    readonly sensitiveEncrypt?: boolean
    readonly sessionSearch?: boolean
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

export function sendMessageAcrossSessionsFeatureEnabled(options: Readonly<Record<string, unknown>>): boolean {
  const features = options.features
  return !isRecord(features) || features.sendMessageAcrossSessions !== false
}

export function imageGenFeatureEnabled(options: Readonly<Record<string, unknown>>): boolean {
  const features = options.features
  return !isRecord(features) || features.imageGen !== false
}

export function promptSearchFeatureEnabled(options: Readonly<Record<string, unknown>>): boolean {
  const features = options.features
  return !isRecord(features) || features.promptSearch !== false
}

// This tool can expose local files, so it is opt-in even when a public key exists.
export function sensitiveEncryptFeatureEnabled(options: Readonly<Record<string, unknown>>): boolean {
  const features = options.features
  return isRecord(features) && features.sensitiveEncrypt === true
}

export function sessionSearchFeatureEnabled(options: Readonly<Record<string, unknown>>): boolean {
  const features = options.features
  return !isRecord(features) || features.sessionSearch !== false
}

export function showImgFeatureEnabled(options: Readonly<Record<string, unknown>>): boolean {
  const features = options.features
  return !isRecord(features) || features.showImg !== false
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
