import { Media } from "@opencode/ai"
import { Option, Result, Schema } from "effect"
import { Base64 } from "effect/encoding"

const decodeFailure = Schema.decodeUnknownOption(Schema.Struct({
  _tag: Schema.Literal("AI.Error"),
  reason: Schema.Struct({
    _tag: Schema.Literal("InvalidProviderOutput"),
    route: Schema.Literal("openai-images"),
    body: Schema.String,
    http: Schema.optional(Schema.Struct({ status: Schema.Number })),
  }),
}))
const optionalString = Schema.optional(Schema.NullOr(Schema.String))
const optionalNumber = Schema.optional(Schema.NullOr(Schema.Number))
const decodeResult = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Struct({
  data: Schema.Array(Schema.Struct({ b64_json: optionalString, url: optionalString, mime_type: optionalString })),
  output_format: optionalString,
  size: optionalString,
  quality: optionalString,
  background: optionalString,
  usage: Schema.optional(Schema.NullOr(Schema.Struct({
    input_tokens: optionalNumber,
    output_tokens: optionalNumber,
    total_tokens: optionalNumber,
    input_tokens_details: Schema.optional(Schema.NullOr(Schema.Record(Schema.String, Schema.Unknown))),
    output_tokens_details: Schema.optional(Schema.NullOr(Schema.Record(Schema.String, Schema.Unknown))),
  }))),
})))

// Recover compatible URL/null-metadata responses without repeating the image request.
export function openAICompatibleImage(error: unknown): Media.Asset | undefined {
  const failure = decodeFailure(error)
  if (Option.isNone(failure)) return
  const status = failure.value.reason.http?.status
  if (status !== undefined && (status < 200 || status >= 300)) return
  const result = decodeResult(failure.value.reason.body)
  if (Option.isNone(result)) return
  const { data, usage, ...settings } = result.value
  const nullable = Object.values(settings).some((value) => value === null) || usage === null ||
    (usage && Object.values(usage).some((value) => value === null)) || data.some((image) => image.mime_type === null)
  if (!nullable && !data.some((image) => image.url)) return
  const images: Media.Asset[] = []
  for (const image of data) {
    const mediaType = image.mime_type ?? `image/${settings.output_format ?? "png"}`
    if (image.b64_json) {
      const decoded = Base64.decode(image.b64_json)
      if (Result.isFailure(decoded) || decoded.success.byteLength === 0) return
      images.push(Media.bytes(decoded.success, mediaType))
    } else if (image.url) {
      let url: URL
      try { url = new URL(image.url) } catch { return }
      if (!["https:", "http:", "data:"].includes(url.protocol)) return
      if (url.protocol === "data:" && !Media.parseDataUrl(image.url)) return
      images.push(Media.url(image.url, { mediaType }))
    } else return
  }
  return images[0]
}
