import { Media } from "@opencode/ai"
import { Option, Schema } from "effect"

const decodeFailure = Schema.decodeUnknownOption(Schema.Struct({
  _tag: Schema.Literal("AI.Error"),
  reason: Schema.Struct({
    _tag: Schema.Literal("InvalidProviderOutput"),
    route: Schema.Literal("openai-images"),
    body: Schema.String,
  }),
}))
const decodeResult = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Struct({
  data: Schema.Array(Schema.Union([
    Schema.Struct({ b64_json: Schema.String, mime_type: Schema.optional(Schema.String) }),
    Schema.Struct({ url: Schema.String, mime_type: Schema.optional(Schema.String) }),
  ])),
  output_format: Schema.optional(Schema.String),
})))

// Keep URL responses supported by compatible gateways without retrying the image request.
export function openAIURLImage(error: unknown): Media.Asset | undefined {
  const failure = decodeFailure(error)
  if (Option.isNone(failure)) return
  const result = decodeResult(failure.value.reason.body)
  if (Option.isNone(result) || !result.value.data.some((image) => "url" in image)) return
  const image = result.value.data[0]
  if (!image) return
  const mediaType = image.mime_type ?? `image/${result.value.output_format ?? "png"}`
  return "b64_json" in image ? Media.base64(image.b64_json, mediaType) : Media.url(image.url, { mediaType })
}
