import { afterEach, beforeEach, expect, mock, test } from "bun:test"
import { generateImage } from "../src/openai-images.js"

const originalFetch = globalThis.fetch
let currentFetch = originalFetch
// The SDK caches its fetch layer. Keep one dispatcher and replace only its handler per case.
const routedFetch = ((...args: Parameters<typeof fetch>) => currentFetch(...args)) as typeof fetch

beforeEach(() => {
  globalThis.fetch = routedFetch
})

afterEach(() => {
  globalThis.fetch = originalFetch
  currentFetch = originalFetch
})

const latestModels = ["gpt-image-2.5-sunburst", "gpt-image-2.5-flare", "gpt-image-2.5-sunburst-2026-09-08"]
const latestCases = latestModels.flatMap((model) => (["generate", "edit"] as const).flatMap((kind) =>
  (["xhigh", "max"] as const).map((quality) => ({ model, kind, quality })),
))

test.each(["@opencode/ai/providers/meta/chat", "@opencode/ai/providers/meta/messages", "@opencode/ai/providers/meta/responses", "@opencode/ai/providers/zai/chat"])("native language entrypoint %s uses its family's image adapter", async (packageName) => {
  currentFetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init)
    if (request.method === "GET") return new Response("PNG", { headers: { "content-type": "image/png" } })
    expect(request.url).toBe("https://custom.example/v1/images/generations")
    expect(request.headers.get("authorization")).toBe("Bearer synthetic")
    if (packageName.includes("/zai/")) return Response.json({ data: [{ url: "https://images.example.test/result.png" }] })
    return Response.json({ data: [{ b64_json: Buffer.from("PNG").toString("base64") }] })
  }) as unknown as typeof fetch
  const image = await generateImage({ providerID: "native", packageName, baseURL: "https://custom.example/v1", token: "synthetic", prompt: "proof", model: "image" })
  expect([...image.data]).toEqual([80, 78, 71])
})

test("pre-cancelled generation makes no HTTP request", async () => {
  let calls = 0
  currentFetch = mock(async () => { calls++; return Response.json({ data: [{ b64_json: "UE5H" }] }) }) as unknown as typeof fetch
  await expect(generateImage({ providerID: "openai", token: "synthetic", model: "image", prompt: "proof", signal: AbortSignal.abort() })).rejects.toThrow()
  expect(calls).toBe(0)
})

test.each(["generation", "download"])("cancelling %s aborts the in-flight operation", async (phase) => {
  const controller = new AbortController()
  let aborted = false
  currentFetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init)
    if (phase === "download" && request.method === "POST") return Response.json({ data: [{ url: "https://images.example.test/result.png" }] })
    return new Promise<Response>((resolve, reject) => {
      const timer = setTimeout(() => resolve(phase === "generation" ? Response.json({ data: [{ b64_json: "UE5H" }] }) : new Response("PNG")), 500)
      request.signal.addEventListener("abort", () => { clearTimeout(timer); aborted = true; reject(new DOMException("Aborted", "AbortError")) }, { once: true })
      controller.abort()
    })
  }) as unknown as typeof fetch
  await expect(generateImage({ providerID: "openai", token: "synthetic", model: "image", prompt: "proof", signal: controller.signal })).rejects.toThrow()
  expect(aborted).toBe(true)
})

test.each(["generate", "edit"].flatMap((kind) => ["https", "data"].map((source) => ({ kind, source }))))("preserves $source URL image results for $kind without repeating generation or leaking auth to downloads", async ({ kind, source }) => {
  let generations = 0
  let downloads = 0
  currentFetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init)
    if (request.method === "POST") {
      generations++
      expect(new URL(request.url).pathname).toBe(`/v1/images/${kind === "edit" ? "edits" : "generations"}`)
      expect(request.headers.get("authorization")).toBe("Bearer synthetic")
      return Response.json({ data: [{ url: source === "https" ? "https://images.example.test/result.png" : "data:image/png;base64,UE5H" }] })
    }
    downloads++
    expect(request.url).toBe("https://images.example.test/result.png")
    expect(request.headers.get("authorization")).toBeNull()
    expect(request.headers.get("x-opencode-session-id")).toBeNull()
    return new Response("PNG", { headers: { "content-type": "image/png" } })
  }) as unknown as typeof fetch
  const result = await generateImage({
    providerID: "gateway", packageName: "@opencode/ai/providers/openai-compatible", baseURL: "https://custom.example/v1",
    token: "synthetic", sessionID: "synthetic-session", model: "image", prompt: "proof",
    images: kind === "edit" ? [{ path: "/reference.png", name: "reference.png", mediaType: "image/png", data: new Uint8Array([80, 78, 71]) }] : undefined,
  })
  expect(new TextDecoder().decode(result.data)).toBe("PNG")
  expect(result.mediaType).toBe("image/png")
  expect(generations).toBe(1)
  expect(downloads).toBe(source === "https" ? 1 : 0)
})

const authCases = (["header", "inline", "anonymous", "connection"] as const).flatMap((auth) =>
  (["generate", "edit"] as const).map((kind) => ({ auth, kind })),
)
test.each(authCases)("uses $auth authentication for $kind without requiring a credential file", async ({ auth, kind }) => {
  let calls = 0
  currentFetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
    calls++
    const request = new Request(input, init)
    expect(request.url).toBe(`https://custom.example/v1/images/${kind === "edit" ? "edits" : "generations"}`)
    expect(request.headers.get("authorization")).toBe(auth === "header" ? "Basic synthetic" : auth === "anonymous" ? null : auth === "inline" ? "Bearer inline" : "Bearer connection")
    if (kind === "edit") expect((await request.formData()).get("image[]")).toBeInstanceOf(File)
    return Response.json({ data: [{ b64_json: Buffer.from("PNG").toString("base64") }] })
  }) as unknown as typeof fetch
  await generateImage({
    providerID: "custom", packageName: "@opencode/ai/providers/openai-compatible", activation: "enabled", baseURL: "https://custom.example/v1",
    model: "image", prompt: "proof", token: auth === "connection" ? "connection" : undefined,
    settings: auth === "inline" || auth === "connection" ? { apiKey: "inline" } : {}, headers: auth === "header" ? { Authorization: "Basic synthetic" } : {},
    images: kind === "edit" ? [{ path: "/server/reference.png", name: "reference.png", mediaType: "image/png", data: new Uint8Array([137, 80, 78, 71]) }] : undefined,
  })
  expect(calls).toBe(1)
})

test("auth failures and unsupported native providers never retry against a weaker OpenAI fallback", async () => {
  let calls = 0
  currentFetch = mock(async () => {
    calls++
    return Response.json({ error: { message: "authentication rejected" } }, { status: 401 })
  }) as unknown as typeof fetch
  await expect(generateImage({ providerID: "custom", packageName: "@opencode/ai/providers/openai-compatible", activation: "enabled", baseURL: "https://custom.example/v1", settings: { apiKey: "bad-key" }, prompt: "proof", model: "image" })).rejects.toThrow("authentication rejected")
  expect(calls).toBe(1)
  await expect(generateImage({ providerID: "mistral", packageName: "@opencode/ai/providers/mistral", baseURL: "https://custom.example/v1", token: "synthetic", prompt: "proof", model: "image" })).rejects.toThrow("does not support image generation")
  expect(calls).toBe(1)
})

test.each(latestCases)("passes $model and $quality unchanged to the $kind Image API", async ({ model, kind, quality }) => {
  const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])
  let calls = 0
  currentFetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
    calls++
    const request = new Request(input, init)
    expect(request.url).toBe(`https://image.example/v1/images/${kind === "generate" ? "generations" : "edits"}`)
    expect(request.headers.get("authorization")).toBe("Bearer test-token")
    expect(request.headers.get("x-provider")).toBe("configured")
    if (kind === "generate") {
      expect(await request.json()).toEqual({ model, prompt: "latest image", n: 1, output_format: "png", quality, size: "1024x1024", moderation: "auto" })
    } else {
      const form = await request.formData()
      expect(form.get("model")).toBe(model)
      expect(form.get("quality")).toBe(quality)
      expect(form.get("size")).toBe("1024x1024")
      expect(form.get("moderation")).toBe("auto")
      const reference = form.get("image[]")
      expect(reference).toBeInstanceOf(File)
      expect(new Uint8Array(await (reference as File).arrayBuffer())).toEqual(bytes)
    }
    return Response.json({ data: [{ b64_json: Buffer.from(bytes).toString("base64") }] })
  }) as unknown as typeof fetch
  const result = await generateImage({
    token: "test-token", providerID: "openai", packageName: "@opencode/ai/providers/openai",
    baseURL: "https://image.example/v1", headers: { "x-provider": "configured" }, body: { moderation: "auto" },
    model, quality, prompt: "latest image", size: "1024x1024",
    images: kind === "edit" ? [{ path: "/server/reference.png", name: "reference.png", mediaType: "image/png", data: bytes }] : undefined,
  })
  expect(result.data).toEqual(bytes)
  expect(result.mediaType).toBe("image/png")
  expect(calls).toBe(1)
})

test("uses the latest image API for OpenAI and native providers", async () => {
  let mode: "generate" | "edit" | "error" | "google" | "xai" | "xai-data-url" | "meta" | "zai" = "generate"
  const nativeRequests: Array<{ mode: string; url: string; body: Record<string, any> }> = []
  const imageData = Buffer.from("PNG").toString("base64")
  const downloadedPng = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  currentFetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
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
