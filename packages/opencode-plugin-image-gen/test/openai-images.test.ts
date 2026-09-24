import { afterEach, expect, mock, test } from "bun:test"
import { generateImage } from "../src/openai-images.js"

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

test("uses the latest image API for OpenAI and native providers", async () => {
  let mode: "generate" | "edit" | "error" | "google" | "xai" | "xai-data-url" | "meta" | "zai" = "generate"
  const nativeRequests: Array<{ mode: string; url: string; body: Record<string, any> }> = []
  const imageData = Buffer.from("PNG").toString("base64")
  const downloadedPng = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init)
    if (new URL(request.url).hostname === "images.example.test") return new Response(downloadedPng)

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
      return Response.json({ data: [{ b64_json: imageData }] })
    }
    if (mode === "error") {
      return Response.json({ error: { message: "Missing scopes: api.model.images.request" } }, { status: 401 })
    }

    if (mode === "edit") {
      expect(request.url).toBe("https://api.example.test/v1/images/edits")
      expect(request.method).toBe("POST")
      expect(request.headers.get("authorization")).toBe("Bearer token")
      expect(request.headers.get("content-type")).toStartWith("multipart/form-data; boundary=")
      const form = await request.formData()
      expect(form.get("model")).toBe("gpt-image-1")
      expect(form.get("prompt")).toBe("edit this")
      expect(form.get("image[]")).toBeInstanceOf(File)
      return Response.json({ data: [{ b64_json: Buffer.from("EDIT").toString("base64") }] })
    }

    const body = (await request.json()) as Record<string, any>
    nativeRequests.push({ mode, url: request.url, body })
    if (mode === "google") {
      return Response.json({
        candidates: [{ content: { parts: [{ inlineData: { mimeType: "image/png", data: imageData } }] }, finishReason: "STOP" }],
      })
    }
    if (mode === "xai-data-url") {
      return Response.json({ data: [{ url: `data:image/png;base64,${imageData}`, mime_type: "image/png" }] })
    }
    if (mode === "zai") return Response.json({ data: [{ url: "https://images.example.test/result.png" }] })
    return Response.json({ data: [{ b64_json: imageData, mime_type: "image/png" }] })
  }) as unknown as typeof fetch

  const generated = await generateImage({
    baseURL: "https://api.example.test/v1",
    token: "token",
    providerID: "custom",
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
    providerID: "custom",
    model: "gpt-image-1",
    prompt: "edit this",
    images: [{ path: "/tmp/ref.png", name: "ref.png", mediaType: "image/png", data: new Uint8Array([1, 2]) }],
  })
  expect(new TextDecoder().decode(edited.data)).toBe("EDIT")

  mode = "error"
  await expect(
    generateImage({ token: "token", providerID: "openai", model: "gpt-image-1", prompt: "a cat" }),
  ).rejects.toThrow("Missing scopes: api.model.images.request")

  const cases = [
    {
      mode: "google" as const,
      providerID: "google",
      packageName: "@opencode/ai/providers/google",
      model: "gemini-image",
      size: "2048x1024",
    },
    {
      mode: "google" as const,
      providerID: "google",
      packageName: "@opencode/ai/providers/google",
      model: "gemini-image",
      size: "1:1",
    },
    { mode: "xai" as const, providerID: "xai", packageName: "@opencode/ai/providers/xai", model: "grok-image", size: "2048x1024" },
    { mode: "xai" as const, providerID: "xai", packageName: "@opencode/ai/providers/xai", model: "grok-image", size: "1:1" },
    { mode: "meta" as const, providerID: "meta", packageName: "@opencode/ai/providers/meta", model: "meta-image", size: "2048x1024" },
    { mode: "meta" as const, providerID: "meta", packageName: "@opencode/ai/providers/meta", model: "meta-image", size: "1:1" },
    { mode: "zai" as const, providerID: "zai", packageName: "@opencode/ai/providers/zai", model: "cogview-image", size: "2048x1024" },
    { mode: "zai" as const, providerID: "zai", packageName: "@opencode/ai/providers/zai", model: "cogview-image", size: "1:1" },
  ]

  for (const input of cases) {
    mode = input.mode
    const result = await generateImage({
      baseURL: "https://api.example.test/v1",
      token: "token",
      prompt: "native provider image",
      quality: "high",
      ...input,
    })
    expect([...result.data]).toEqual(input.providerID === "zai" ? [...downloadedPng] : [80, 78, 71])
    expect(result.mediaType).toBe("image/png")
  }

  expect(nativeRequests[0]).toMatchObject({
    url: "https://api.example.test/v1/models/gemini-image:generateContent",
    body: {
      generationConfig: {
        imageConfig: { aspectRatio: "16:9", imageSize: "2K" },
        thinkingConfig: { thinkingLevel: "HIGH" },
      },
    },
  })
  expect(nativeRequests[1]?.body.generationConfig.imageConfig).toEqual({ aspectRatio: "1:1" })
  expect(nativeRequests[2]).toMatchObject({
    body: { n: 1, aspect_ratio: "16:9", resolution: "2k", response_format: "b64_json" },
  })
  expect(nativeRequests[3]).toMatchObject({
    body: { n: 1, aspect_ratio: "1:1", resolution: "1k", response_format: "b64_json" },
  })
  expect(nativeRequests[4]).toMatchObject({
    body: { n: 1, size: "2048x1024", output_format: "png", response_format: "b64_json" },
  })
  expect(nativeRequests[5]).toMatchObject({ body: { n: 1, size: "1:1", output_format: "png" } })
  expect(nativeRequests[6]).toMatchObject({ body: { size: "2048x1024", quality: "hd" } })
  expect(nativeRequests[7]).toMatchObject({ body: { size: "1:1", quality: "hd" } })

  mode = "xai-data-url"
  const dataUrlResult = await generateImage({
    baseURL: "https://api.example.test/v1",
    token: "token",
    providerID: "xai",
    packageName: "@opencode/ai/providers/xai",
    model: "grok-image",
    prompt: "data URL image",
  })
  expect([...dataUrlResult.data]).toEqual([80, 78, 71])
  expect(dataUrlResult.mediaType).toBe("image/png")
})
