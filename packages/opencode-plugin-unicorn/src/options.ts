export interface UnicornOptions {
  readonly maxPrompts?: number
  readonly sessionSearchKeybind?: string
  readonly features?: {
    readonly recommendedOpencodeConfig?: boolean
    readonly sendMessageAcrossSessions?: boolean
    readonly imageGen?: boolean
    readonly showImg?: boolean
    readonly promptSearch?: boolean
    readonly sessionSearch?: boolean
  }
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
