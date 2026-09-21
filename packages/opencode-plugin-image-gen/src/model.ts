import type { Context } from "@opencode/plugin/promise/plugin"
import type { ModelReference, ResolvedImageModel } from "./types.js"

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
  const separator = value.indexOf("/")
  if (separator < 0) {
    if (!fallbackProviderID) throw new Error(`Model reference must include a provider: ${value}`)
    return { providerID: fallbackProviderID, modelID: value.split("#", 1)[0] }
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
  const model = requestedModel ?? configuredModel
  const reference = model
    ? parseModelReference(model, sessionModel?.providerID)
    : sessionModel
      ? { providerID: sessionModel.providerID, modelID: sessionModel.id }
      : undefined

  if (!reference) {
    throw new Error("No model is selected for this session. Select a session model or configure image_gen.model.")
  }

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
  // For an image-only model that is not in the language-model catalog (for
  // example openai/gpt-image-2), fall back to the provider definition.
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
