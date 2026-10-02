export interface UnicornOptions {
  readonly globalConfig?: boolean
  readonly maxPrompts?: number
  readonly features?: {
    readonly globalConfig?: boolean
    readonly sendMessageAcrossSessions?: boolean
    readonly imageGen?: boolean
    readonly showImg?: boolean
    readonly promptSearch?: boolean
  }
}

export function globalConfigFeatureEnabled(options: Readonly<Record<string, unknown>>): boolean {
  if (options.globalConfig === false) return false
  if (options.globalConfig === true) return true

  const features = options.features
  return !isRecord(features) || features.globalConfig !== false
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

export function showImgFeatureEnabled(options: Readonly<Record<string, unknown>>): boolean {
  const features = options.features
  return !isRecord(features) || features.showImg !== false
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
