import type { ImageModel, LanguageModel } from "@opencode/ai"
import { Auth } from "@opencode/ai/route"
import { Google, Meta, OpenAI, OpenAICompatible, OpenAICompatibleResponses, XAI, ZAI } from "@opencode/ai/providers"
import type { ImageRequest } from "./openai-images.js"

type Factory = {
  readonly model?: (id: string, settings: Record<string, unknown>) => LanguageModel
  readonly configure: (input: Record<string, unknown>) => { readonly image?: (id: string) => ImageModel }
}
type Provider = { language: Factory; media: Factory; family?: string; apiKeyAuth: boolean }
const CORE_SETTINGS = new Set(["chunkTimeout", "compaction", "fetch", "timeout", "transport"])
const API_KEY_PACKAGES = new Set([
  "anthropic", "anthropic-compatible", "baseten", "cerebras", "cloudflare-ai-gateway", "cloudflare-workers-ai",
  "deepinfra", "deepseek", "fireworks", "google", "groq", "mistral", "openai", "openai-compatible", "openrouter", "togetherai", "xai", "azure",
].map((name) => `@opencode/ai/providers/${name}`))

export function normalizePackage(value?: string) {
  if (value?.startsWith("aisdk:")) value = value.slice(6)
  if (value?.startsWith("@opencode-ai/ai/")) value = value.replace("@opencode-ai/", "@opencode/")
  const equivalents: Record<string, string> = {
    "@ai-sdk/openai": "@opencode/ai/providers/openai",
    "@ai-sdk/openai-compatible": "@opencode/ai/providers/openai-compatible",
    "@ai-sdk/google": "@opencode/ai/providers/google",
    "@ai-sdk/xai": "@opencode/ai/providers/xai",
  }
  return value && (Object.hasOwn(equivalents, value) ? equivalents[value] : value)
}

async function providerFor(request: ImageRequest): Promise<Provider> {
  const name = normalizePackage(request.packageName)
  const openAI = OpenAI as unknown as Factory
  const compatible = OpenAICompatible as unknown as Factory
  if (!name) {
    if (request.providerID === "openai") return { language: openAI, media: openAI, apiKeyAuth: true }
    if (request.baseURL || typeof request.settings?.baseURL === "string") return { language: compatible, media: openAI, apiKeyAuth: true }
    throw new Error(`Provider ${request.providerID} does not define an image-capable package or compatible endpoint`)
  }
  if (name === "@opencode/ai/providers/openai" || name === "@opencode/ai/providers/openai/responses") return { language: openAI, media: openAI, apiKeyAuth: true }
  if (name === "@opencode/ai/providers/openai/chat") return { language: { ...openAI, model: OpenAI.chatModel as Factory["model"] }, media: openAI, apiKeyAuth: true }
  if (name === "@opencode/ai/providers/openai-compatible") return { language: compatible, media: openAI, apiKeyAuth: true }
  if (name === "@opencode/ai/providers/openai-compatible/responses" || name === "@opencode/ai/providers/openai-compatible-responses") return { language: OpenAICompatibleResponses as unknown as Factory, media: openAI, apiKeyAuth: false }
  if (name === "@opencode/ai/providers/meta/chat" || name === "@opencode/ai/providers/meta/messages" || name === "@opencode/ai/providers/meta/responses") {
    const model = name.endsWith("/chat") ? Meta.chatModel : name.endsWith("/messages") ? Meta.messagesModel : Meta.model
    return { language: { ...Meta, model } as unknown as Factory, media: Meta as unknown as Factory, family: "@opencode/ai/providers/meta", apiKeyAuth: false }
  }
  if (name === "@opencode/ai/providers/zai/chat") return { language: ZAI as unknown as Factory, media: ZAI as unknown as Factory, family: "@opencode/ai/providers/zai", apiKeyAuth: false }
  for (const [family, module] of [["google", Google], ["xai", XAI], ["meta", Meta], ["zai", ZAI]] as const) {
    const root = `@opencode/ai/providers/${family}`
    if (name === root) return { language: module as unknown as Factory, media: module as unknown as Factory, family: root, apiKeyAuth: API_KEY_PACKAGES.has(root) }
  }
  if (name.startsWith("@ai-sdk/") || request.packageName?.startsWith("aisdk:")) throw new Error(`Provider package ${name} needs a native image adapter; it cannot safely use an OpenAI fallback`)
  let module: Factory
  try { module = await import(name) as Factory } catch {
    throw new Error(`Cannot load provider package ${name} from image-gen; use an installed native package or a file URL`)
  }
  if (typeof module.configure !== "function") throw new Error(`Provider package ${name} does not expose a native image factory`)
  return { language: module, media: module, family: name, apiKeyAuth: API_KEY_PACKAGES.has(name) || name.startsWith("@opencode/ai/providers/azure/") }
}

export async function prepareImageModel(request: ImageRequest): Promise<{ model: ImageModel; family?: string }> {
  const provider = await providerFor(request)
  const name = normalizePackage(request.packageName)
  const settings = Object.fromEntries(Object.entries(request.settings ?? {}).filter(([key]) => !CORE_SETTINGS.has(key)))
  if (settings.apiKey === "") delete settings.apiKey
  const hasCredential = request.token !== undefined
  if (hasCredential) {
    delete settings.apiKey
    delete settings.authToken
    delete settings.accessToken
    const vertex = name === "@opencode/ai/providers/google-vertex" || name?.startsWith("@opencode/ai/providers/google-vertex/")
    const anthropic = name === "@opencode/ai/providers/anthropic" || name === "@opencode/ai/providers/anthropic-compatible"
    const key = request.credentialType === "oauth" && vertex ? "accessToken"
      : request.credentialType === "oauth" && anthropic ? "authToken" : "apiKey"
    settings[key] = request.token
  }
  const baseURL = request.baseURL ?? settings.baseURL
  if (typeof baseURL === "string" && /\$\{[^}]+\}/.test(baseURL)) throw new Error("Provider baseURL contains unresolved environment variables")
  const configured = {
    ...settings,
    ...(baseURL !== undefined ? { baseURL } : {}),
    ...(request.canonical === undefined ? {} : { provider: request.canonical }),
    headers: { ...request.headers }, body: { ...request.body },
  }
  const language = provider.language.model?.(request.model, configured)
  const configuredAuth = [settings.apiKey, settings.authToken, settings.accessToken].some((value) => typeof value === "string" && value !== "")
  const auth = !hasCredential && !configuredAuth && provider.apiKeyAuth && request.activation === "enabled"
    ? Auth.none : language?.route.auth
  const preparedBaseURL = language?.route.endpoint.baseURL ?? baseURL
  if (preparedBaseURL !== undefined && typeof preparedBaseURL !== "string") throw new Error("Image-gen requires a string provider deployment URL")
  if (typeof preparedBaseURL === "string" && /\$\{[^}]+\}/.test(preparedBaseURL)) throw new Error("Provider baseURL contains unresolved environment variables")
  const defaults = language?.route.defaults
  const input: Record<string, unknown> = {
    ...settings,
    ...(request.canonical === undefined ? {} : { provider: request.canonical }),
    ...(preparedBaseURL !== undefined ? { baseURL: preparedBaseURL } : {}),
    ...(auth ? { auth } : {}),
    headers: defaults?.headers ?? request.headers,
    http: {
      ...(defaults?.http ?? { body: request.body }),
      ...(language?.route.endpoint.query ? { query: { ...language.route.endpoint.query, ...defaults?.http?.query } } : {}),
    },
  }
  // Do not reinterpret package-specific settings (notably queryParams) with the fallback factory.
  if (language) delete input.queryParams
  const configuredMedia = provider.media.configure(input)
  if (typeof configuredMedia.image !== "function") throw new Error(`Provider package ${name ?? request.providerID} does not support image generation`)
  return { model: configuredMedia.image(request.model), family: provider.family }
}
