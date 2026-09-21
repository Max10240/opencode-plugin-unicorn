import { afterEach, expect, mock, test } from "bun:test"
import { generateImage } from "../src/openai-images.js"

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

test("uses the standard generations and edits endpoints", async () => {
  let mode: "generate" | "edit" | "error" = "generate"
  globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init)
    if (mode === "generate") {
      expect(request.url).toBe("https://api.example.test/v1/images/generations")
      expect(request.method).toBe("POST")
      expect(request.headers.get("authorization")).toBe("Bearer token")
      expect(request.headers.get("content-type")).toBe("application/json")
      expect(await request.json()).toEqual({
        model: "gpt-image-1",
        prompt: "a cat",
        n: 1,
        output_format: "png",
        quality: "low",
        size: "1024x1024",
      })
      return new Response(JSON.stringify({ data: [{ b64_json: Buffer.from("PNG").toString("base64") }] }), {
        status: 200,
      })
    }
    if (mode === "error") {
      return new Response(JSON.stringify({ error: { message: "Missing scopes: api.model.images.request" } }), {
        status: 401,
      })
    }

    expect(request.url).toBe("https://api.example.test/v1/images/edits")
    expect(request.method).toBe("POST")
    expect(request.headers.get("authorization")).toBe("Bearer token")
    expect(request.headers.get("content-type")).toStartWith("multipart/form-data; boundary=")
    const form = await request.formData()
    expect(form.get("model")).toBe("gpt-image-1")
    expect(form.get("prompt")).toBe("edit this")
    expect(form.get("image[]")).toBeInstanceOf(File)
    return new Response(JSON.stringify({ data: [{ b64_json: Buffer.from("EDIT").toString("base64") }] }), {
      status: 200,
    })
  }) as unknown as typeof fetch

  const generated = await generateImage({
    baseURL: "https://api.example.test/v1",
    token: "token",
    model: "gpt-image-1",
    prompt: "a cat",
    quality: "low",
    size: "1024x1024",
  })
  expect(new TextDecoder().decode(generated.data)).toBe("PNG")
  expect(generated.mediaType).toBe("image/png")

  mode = "edit"

  const edited = await generateImage({
    baseURL: "https://api.example.test/v1",
    token: "token",
    model: "gpt-image-1",
    prompt: "edit this",
    images: [{ path: "/tmp/ref.png", name: "ref.png", mediaType: "image/png", data: new Uint8Array([1, 2]) }],
  })
  expect(new TextDecoder().decode(edited.data)).toBe("EDIT")

  mode = "error"
  expect(generateImage({ token: "token", model: "gpt-image-1", prompt: "a cat" })).rejects.toThrow(
    "Missing scopes: api.model.images.request",
  )
})
