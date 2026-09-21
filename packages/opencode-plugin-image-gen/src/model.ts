import type { Context } from "@opencode/plugin/promise/plugin"
import type { ImageGenOptions, ModelReference, ResolvedImageModel } from "./types.js"

type SessionModel = {
  readonly id: string
  readonly providerID: string
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
  context: Pick<Context, "options" | "provider" | "session">,
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

  let integrationID = reference.providerID
  let baseURL: string | undefined
  let headers: Readonly<Record<string, string>> = {}
  try {
    const provider = await context.provider.get({ providerID: reference.providerID })
    integrationID = provider.data.integrationID ?? reference.providerID
    baseURL = typeof provider.data.settings?.baseURL === "string" ? provider.data.settings.baseURL : undefined
    headers = provider.data.headers ?? {}
  } catch {
    // A configured provider may not expose catalog metadata. Its ID is also
    // the conventional integration ID, so keep the useful fallback.
  }

  return {
    ...reference,
    integrationID:
      typeof context.options.integrationID === "string" ? context.options.integrationID : integrationID,
    directory: session.location.directory,
    baseURL,
    headers,
  }
}
