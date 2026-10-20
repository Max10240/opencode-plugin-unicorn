import type { Context } from "@opencode/plugin/promise/plugin"
import type { ModelReference, ResolvedImageModel } from "./types.js"
import { mergeHeaders, mergeOverlay } from "./overlay.js"

// OpenAI's recommended Image API model, verified against official docs on 2026-10-02.
export const DEFAULT_IMAGE_MODEL = "openai/gpt-image-2.5-sunburst"

type SessionModel = {
  readonly id: string
  readonly providerID: string
  readonly variant?: string
}

type CatalogModel = {
  readonly id: string
  readonly modelID?: string
  readonly providerID: string
  readonly package?: string
  readonly settings?: Record<string, unknown>
  readonly headers?: Record<string, string>
  readonly body?: Record<string, unknown>
  readonly canonical?: string
  readonly variants?: readonly { id: string; settings?: Record<string, unknown>; headers?: Record<string, string>; body?: Record<string, unknown> }[]
}

export function parseModelReference(value: string, fallbackProviderID?: string): ModelReference {
  value = value.trim()
  const hash = value.indexOf("#")
  const variant = hash < 0 ? undefined : value.slice(hash + 1)
  if (hash >= 0 && (!variant || variant.includes("#"))) throw new Error(`Invalid model reference: ${value}`)
  const suffix = variant && variant !== "default" ? { variant } : {}
  const modelReference = hash < 0 ? value : value.slice(0, hash)
  const separator = modelReference.indexOf("/")
  if (separator < 0) {
    if (!fallbackProviderID) throw new Error(`Model reference must include a provider: ${value}`)
    const modelID = modelReference
    if (!modelID) throw new Error(`Invalid model reference: ${value}`)
    return { providerID: fallbackProviderID, modelID, ...suffix }
  }

  const providerID = modelReference.slice(0, separator)
  const modelID = modelReference.slice(separator + 1)
  if (!providerID || !modelID) throw new Error(`Invalid model reference: ${value}`)
  return { providerID, modelID, ...suffix }
}

export async function resolveImageModel(
  context: Pick<Context, "options" | "model" | "provider" | "session">,
  sessionID: string,
  requestedModel?: string,
): Promise<ResolvedImageModel> {
  const session = await context.session.get({ sessionID })
  const sessionModel = session.model as SessionModel | null | undefined
  const configuredModel = typeof context.options.model === "string" ? context.options.model : undefined
  const selection = requestedModel ?? configuredModel ?? DEFAULT_IMAGE_MODEL
  const reference = parseModelReference(
    selection,
    sessionModel?.providerID ?? "openai",
  )
  if (!selection.includes("#") && reference.providerID === sessionModel?.providerID && reference.modelID === sessionModel.id && sessionModel.variant && sessionModel.variant !== "default") {
    Object.assign(reference, { variant: sessionModel.variant })
  }

  const catalog = (await context.model.list()).data as readonly CatalogModel[]
  const catalogModel = catalog.find((item) => item.providerID === reference.providerID && item.id === reference.modelID)
  const provider: {
    readonly integrationID?: string
    readonly package?: string
    readonly settings?: Record<string, unknown>
    readonly headers?: Record<string, string>
    readonly body?: Record<string, unknown>
    readonly canonical?: string
    readonly activation?: "auto" | "enabled" | "disabled"
  } = (await context.provider.get({ providerID: reference.providerID })).data
  if (!provider || provider.activation === "disabled") throw new Error(`Provider unavailable: ${reference.providerID}`)

  // model.list() is the important source here: Core has already merged global
  // provider settings, model overrides, headers, body, package and modelID.
  // Image-only models may be absent from the chat catalog; inherit provider defaults instead.
  const variant = reference.variant ? catalogModel?.variants?.find((item) => item.id === reference.variant) : undefined
  if (reference.variant && !variant) throw new Error(`Variant unavailable for ${reference.providerID}/${reference.modelID}: ${reference.variant}`)
  const settings = mergeOverlay(mergeOverlay(provider.settings, catalogModel?.settings), variant?.settings)
  const baseURL = resolveEnvironmentURL(settings.baseURL)
  const headers = mergeHeaders(catalogModel?.headers ?? provider.headers, variant?.headers)
  const body = mergeOverlay(catalogModel?.body ?? provider.body, variant?.body)

  return {
    ...reference,
    integrationID:
      typeof context.options.integrationID === "string"
        ? context.options.integrationID
        : provider.integrationID ?? reference.providerID,
    directory: session.location.directory,
    baseURL,
    modelID: catalogModel?.modelID ?? reference.modelID,
    packageName: catalogModel?.package ?? provider.package,
    canonical: catalogModel?.canonical ?? provider.canonical,
    activation: provider.activation,
    settings,
    headers,
    body,
  }
}

function resolveEnvironmentURL(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined
  return value.replace(/\$\{([^}]+)\}/g, (placeholder, name: string) => process.env[name] ?? placeholder)
}
