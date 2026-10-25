import { expect, test } from "bun:test"
import { openAICompatibleImage } from "../src/openai-image-result.js"

const body = JSON.stringify({ data: [{ url: "https://images.example.test/result.png" }] })
const failure = (raw = body, route = "openai-images") => ({ _tag: "AI.Error", reason: { _tag: "InvalidProviderOutput", route, body: raw } })

test("URL compatibility is limited to a validated OpenAI image result, never authentication failures or other protocols", () => {
  for (const error of [undefined, new Error("failed"), failure(body, "google-images"),
    { _tag: "AI.Error", reason: { _tag: "Authentication", route: "openai-images", body } },
    failure("not JSON"), failure('{"data":[]}'), failure('{"data":[{"url":123}]}'),
    failure('{"data":[{"b64_json":"UE5H"}]}'),
  ]) expect(openAICompatibleImage(error)).toBeUndefined()
})

test("compatible URL results preserve declared media type and the first image in mixed responses", () => {
  const url = openAICompatibleImage(failure(JSON.stringify({ data: [{ url: "https://images.example.test/result.webp", mime_type: "image/webp" }] })))
  expect(url?.source).toEqual({ type: "url", url: "https://images.example.test/result.webp", mediaType: "image/webp" })
  const mixed = openAICompatibleImage(failure(JSON.stringify({ data: [{ b64_json: "UE5H" }, { url: "https://images.example.test/result.png" }] })))
  expect(mixed?.source).toEqual({ type: "bytes", data: new Uint8Array([80, 78, 71]), mediaType: "image/png" })
})

test("nullable metadata recovery keeps valid bytes but rejects non-success responses and malformed data", () => {
  const raw = JSON.stringify({ size: null, data: [{ b64_json: "UE5H" }] })
  expect(openAICompatibleImage(failure(raw))?.source).toEqual({ type: "bytes", data: new Uint8Array([80, 78, 71]), mediaType: "image/png" })
  for (const status of [401, 403, 429, 500]) {
    expect(openAICompatibleImage({ _tag: "AI.Error", reason: { ...failure(raw).reason, http: { status } } })).toBeUndefined()
  }
  for (const data of [
    [{ b64_json: "!!!" }, { url: "https://images.example.test/result.png" }],
    [{ b64_json: "!!!", url: "https://images.example.test/result.png" }],
    [{ b64_json: "UE5H" }, {}],
    [{ url: "file:///private/synthetic.png" }],
    [{ url: "../synthetic.png" }],
    [{ url: "data:image/png,not-base64" }],
  ]) expect(openAICompatibleImage(failure(JSON.stringify({ size: null, data })))).toBeUndefined()
})
