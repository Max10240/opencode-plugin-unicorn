import type { Context } from "@opencode/plugin/promise/plugin"
import type { ModelReference, ResolvedImageModel } from "./types.js"

// OpenAI's recommended Image API model, verified against official docs on 2026-10-02.
export const DEFAULT_IMAGE_MODEL = "openai/gpt-image-2.5-sunburst"

type SessionModel = {
  readonly id: string
  readonly providerID: string
}

type CatalogModel = {
  readonly id: string
  readonly modelID?: string
  readonly providerID: string
  readonly package?: string
  readonly settings?: Record<string, unknown>
  readonly headers?: Record<string, string>
  readonly body?: Record<string, unknown>
}

export function parseModelReference(value: string, fallbackProviderID?: string): ModelReference {
  value = value.trim()
  const separator = value.indexOf("/")
  if (separator < 0) {
    if (!fallbackProviderID) throw new Error(`Model reference must include a provider: ${value}`)
    const modelID = value.split("#", 1)[0]
    if (!modelID) throw new Error(`Invalid model reference: ${value}`)
    return { providerID: fallbackProviderID, modelID }
  }

  const providerID = value.slice(0, separator)
  const modelID = value.slice(separator + 1).split("#", 1)[0]
  if (!providerID || !modelID) throw new Error(`Invalid model reference: ${value}`)
  return { providerID, modelID }
}

export async function resolveImageModel(
  context: Pick<Context, "options" | "model" | "provider" | "session">,
  sessionID: string,
  requestedModel?: string,
): Promise<ResolvedImageModel> {
  const session = await context.session.get({ sessionID })
  const sessionModel = session.model as SessionModel | null | undefined
  const configuredModel = typeof context.options.model === "string" ? context.options.model : undefined
  const reference = parseModelReference(
    requestedModel ?? configuredModel ?? DEFAULT_IMAGE_MODEL,
    sessionModel?.providerID ?? "openai",
  )

  const catalog = (await context.model.list()).data as readonly CatalogModel[]
  const catalogModel = catalog.find((item) => item.providerID === reference.providerID && item.id === reference.modelID)
  let provider: {
    readonly integrationID?: string
    readonly package?: string
    readonly settings?: Record<string, unknown>
    readonly headers?: Record<string, string>
    readonly body?: Record<string, unknown>
  }
  try {
    provider = (await context.provider.get({ providerID: reference.providerID })).data
  } catch {
    provider = {}
  }

  // model.list() is the important source here: Core has already merged global
  // provider settings, model overrides, headers, body, package and modelID.
  // Image-only models may be absent from the chat catalog; inherit provider defaults instead.
  const settings = catalogModel?.settings ?? provider.settings ?? {}
  const baseURL = resolveEnvironmentURL(settings.baseURL)
  const headers = catalogModel?.headers ?? provider.headers ?? {}
  const body = catalogModel?.body ?? provider.body ?? {}

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
    settings,
    headers,
    body,
  }
}

function resolveEnvironmentURL(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined
  return value.replace(/\$\{([^}]+)\}/g, (placeholder, name: string) => process.env[name] ?? placeholder)
}
