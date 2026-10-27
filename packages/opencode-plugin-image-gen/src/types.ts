export type ImageQuality = "low" | "medium" | "high" | "xhigh" | "max" | "auto"

export type ImageGenOptions = {
  /** Default model override. Otherwise uses `openai/gpt-image-2.5-sunburst`. */
  readonly model?: unknown
  /** Optional OpenAI-compatible API base URL. Defaults to `https://api.openai.com/v1`. */
  readonly baseURL?: unknown
  /** Optional integration ID when it differs from the provider ID. */
  readonly integrationID?: unknown
}

export type ImageToolInput = {
  readonly prompt: string
  readonly out: string
  readonly model?: string | null
  readonly quality?: ImageQuality | null
  readonly size?: string | null
  readonly images?: string[] | null
}

export type ModelReference = {
  readonly providerID: string
  readonly modelID: string
  readonly variant?: string
}

export type ResolvedImageModel = ModelReference & {
  readonly integrationID: string
  readonly directory: string
  readonly baseURL?: string
  readonly modelID: string
  readonly packageName?: string
  readonly canonical?: string
  readonly activation?: "auto" | "enabled" | "disabled"
  readonly settings: Readonly<Record<string, unknown>>
  readonly headers: Readonly<Record<string, string>>
  readonly body: Readonly<Record<string, unknown>>
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
