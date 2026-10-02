import { expect, test } from "bun:test"
import type { Context } from "@opencode/plugin/promise/plugin"
import { DEFAULT_IMAGE_MODEL, parseModelReference, resolveImageModel } from "../src/model.js"

type ModelContext = Parameters<typeof resolveImageModel>[0]
function fixture(options: Record<string, unknown> = {}, sessionModel: { providerID: string; id: string } | null = { providerID: "google", id: "text-only" }) {
  const providerReads: string[] = []
  const catalog = [
    { id: "configured-image", providerID: "custom", modelID: "wire-image", package: "custom-image-provider", settings: { baseURL: "https://model.example/v1" }, headers: { "x-model": "yes" }, body: { model_setting: true } },
  ]
  const provider = { integrationID: "image-auth", package: "@opencode/ai/providers/openai-compatible", settings: { baseURL: "https://provider.example/v1" }, headers: { "x-provider": "yes" }, body: { provider_setting: true } }
  const context = {
    options,
    session: { get: async () => ({ model: sessionModel, location: { directory: "/server/session" } }) },
    model: { list: async () => ({ data: catalog }) },
    provider: { get: async ({ providerID }: { providerID: string }) => { providerReads.push(providerID); return { data: provider } } },
  } as unknown as ModelContext
  return { context, catalog, provider, providerReads }
}

test("defaults to the latest recommended OpenAI image model, not the session language model", async () => {
  const { context, providerReads } = fixture()
  const result = await resolveImageModel(context, "session")
  expect(`${result.providerID}/${result.modelID}`).toBe(DEFAULT_IMAGE_MODEL)
  expect(DEFAULT_IMAGE_MODEL).toBe("openai/gpt-image-2.5-sunburst")
  expect(providerReads).toEqual(["openai"])
  expect(result.directory).toBe("/server/session")
})

test("tool model overrides plugin config; config overrides the built-in default", async () => {
  const { context } = fixture({ model: "openai/gpt-image-2.5-flare" })
  expect((await resolveImageModel(context, "session")).modelID).toBe("gpt-image-2.5-flare")
  const explicit = await resolveImageModel(context, "session", "custom/configured-image")
  expect(explicit.providerID).toBe("custom")
  expect(explicit.modelID).toBe("wire-image")
  expect(explicit.baseURL).toBe("https://model.example/v1")
  expect(explicit.packageName).toBe("custom-image-provider")
  expect(explicit.headers).toEqual({ "x-model": "yes" })
  expect(explicit.body).toEqual({ model_setting: true })
})

test("image-only models absent from the chat catalog retain provider settings and auth", async () => {
  const { context, provider } = fixture({ model: "openai/gpt-image-2.5-sunburst-2026-09-08", integrationID: "explicit-auth" })
  const result = await resolveImageModel(context, "session")
  expect(result.modelID).toBe("gpt-image-2.5-sunburst-2026-09-08")
  expect(result.baseURL).toBe(provider.settings.baseURL)
  expect(result.packageName).toBe(provider.package)
  expect(result.settings).toEqual(provider.settings)
  expect(result.headers).toEqual(provider.headers)
  expect(result.body).toEqual(provider.body)
  expect(result.integrationID).toBe("explicit-auth")
  expect((await resolveImageModel(fixture().context, "session")).integrationID).toBe("image-auth")
})

test("default and explicit models work without a selected session model", async () => {
  const { context } = fixture({}, null)
  expect((await resolveImageModel(context, "session")).modelID).toBe("gpt-image-2.5-sunburst")
  expect((await resolveImageModel(context, "session", "gpt-image-2.5-flare")).providerID).toBe("openai")
  expect((await resolveImageModel(context, "session", "custom/image-only")).providerID).toBe("custom")
})

test("bare model IDs use the session provider; full references can select another provider", async () => {
  const { context } = fixture({ model: "native-image" })
  expect((await resolveImageModel(context, "session")).providerID).toBe("google")
  expect((await resolveImageModel(context, "session", "openai/gpt-image-2.5-flare")).providerID).toBe("openai")
  expect(parseModelReference(" openai/gpt-image-2.5-sunburst#high ")).toEqual({ providerID: "openai", modelID: "gpt-image-2.5-sunburst" })
})

test("rejects malformed explicit model references instead of silently changing models", async () => {
  for (const input of ["", " ", "openai/", "/image", "#high", "openai/#high"]) {
    await expect(resolveImageModel(fixture().context, "session", input)).rejects.toThrow("Invalid model reference")
  }
  await expect(resolveImageModel(fixture({ model: "" }).context, "session")).rejects.toThrow("Invalid model reference")
  expect(() => parseModelReference("bare-model")).toThrow("include a provider")
})

test("a missing provider definition preserves the OpenAI default without borrowing session settings", async () => {
  const { context } = fixture()
  context.provider.get = (async () => { throw new Error("missing provider") }) as Context["provider"]["get"]
  const result = await resolveImageModel(context, "session")
  expect(`${result.providerID}/${result.modelID}`).toBe(DEFAULT_IMAGE_MODEL)
  expect(result.settings).toEqual({})
  expect(result.baseURL).toBeUndefined()
  expect(result.integrationID).toBe("openai")
})
