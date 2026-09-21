export type ImageQuality = "low" | "medium" | "high" | "auto"

export type ImageGenOptions = {
  /** Optional default model reference, for example `openai/gpt-image-1`. */
  readonly model?: unknown
  /** Optional OpenAI-compatible API base URL. Defaults to `https://api.openai.com/v1`. */
  readonly baseURL?: unknown
  /** Optional integration ID when it differs from the provider ID. */
  readonly integrationID?: unknown
}

export type ImageToolInput = {
  readonly prompt: string
  readonly out: string
  readonly model?: string
  readonly quality?: ImageQuality
  readonly size?: string
  readonly images?: string[]
}

export type ModelReference = {
  readonly providerID: string
  readonly modelID: string
}

export type ResolvedImageModel = ModelReference & {
  readonly integrationID: string
  readonly directory: string
  readonly baseURL?: string
  readonly headers: Readonly<Record<string, string>>
}

export type ResolvedCredential = {
  readonly value: string
  readonly source: "oauth" | "key" | "environment"
  readonly metadata?: Readonly<Record<string, unknown>>
}

export type ImageFile = {
  readonly path: string
  readonly name: string
  readonly mediaType: string
  readonly data: Uint8Array
}

export type GeneratedImage = {
  readonly data: Uint8Array
  readonly mediaType: string
}
