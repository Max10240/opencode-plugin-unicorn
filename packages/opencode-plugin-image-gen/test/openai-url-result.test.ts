import { expect, test } from "bun:test"
import { openAIURLImage } from "../src/openai-url-result.js"

const body = JSON.stringify({ data: [{ url: "https://images.example.test/result.png" }] })
const failure = (raw = body, route = "openai-images") => ({ _tag: "AI.Error", reason: { _tag: "InvalidProviderOutput", route, body: raw } })

test("URL compatibility is limited to a validated OpenAI image result, never authentication failures or other protocols", () => {
  for (const error of [undefined, new Error("failed"), failure(body, "google-images"),
    { _tag: "AI.Error", reason: { _tag: "Authentication", route: "openai-images", body } },
    failure("not JSON"), failure('{"data":[]}'), failure('{"data":[{"url":123}]}'),
    failure('{"data":[{"b64_json":"UE5H"}]}'),
  ]) expect(openAIURLImage(error)).toBeUndefined()
})

test("compatible URL results preserve declared media type and the first image in mixed responses", () => {
  const url = openAIURLImage(failure(JSON.stringify({ data: [{ url: "https://images.example.test/result.webp", mime_type: "image/webp" }] })))
  expect(url?.source).toEqual({ type: "url", url: "https://images.example.test/result.webp", mediaType: "image/webp" })
  const mixed = openAIURLImage(failure(JSON.stringify({ data: [{ b64_json: "UE5H" }, { url: "https://images.example.test/result.png" }] })))
  expect(mixed?.source).toEqual({ type: "base64", data: "UE5H", mediaType: "image/png" })
})
