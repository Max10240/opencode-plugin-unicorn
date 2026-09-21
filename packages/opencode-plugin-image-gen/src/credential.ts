import type { Context } from "@opencode/plugin/promise/plugin"
import type { ResolvedCredential } from "./types.js"

type CredentialContext = Pick<Context, "integration">

export async function resolveCredential(
  context: CredentialContext,
  integrationID: string,
  providerID: string,
): Promise<ResolvedCredential> {
  const connection = await context.integration.connection.active(integrationID)
  if (connection) {
    const credential = await context.integration.connection.resolve(connection)
    if (credential?.type === "oauth") return { value: credential.access, source: "oauth", metadata: credential.metadata }
    if (credential?.type === "key") return { value: credential.key, source: "key" }
  }

  // This is the standard OpenAI-compatible environment fallback. It keeps
  // credentials out of plugin options and mirrors provider configuration.
  if (providerID === "openai" && process.env.OPENAI_API_KEY) {
    return { value: process.env.OPENAI_API_KEY, source: "environment" }
  }

  throw new Error(`No active credential found for provider ${providerID} (integration ${integrationID}).`)
}
