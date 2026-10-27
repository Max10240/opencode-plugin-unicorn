import type { Context } from "@opencode/plugin/promise/plugin"
import type { ResolvedCredential } from "./types.js"
import { mergeOverlay, record } from "./overlay.js"

type CredentialContext = Pick<Context, "integration">

export async function resolveCredential(
  context: CredentialContext,
  integrationID: string,
): Promise<ResolvedCredential | undefined> {
  const connection = await context.integration.connection.active(integrationID)
  if (connection) {
    const credential = await context.integration.connection.resolve(connection)
    if (credential?.type === "oauth") return { value: credential.access, source: "oauth", metadata: credential.metadata }
    if (credential?.type === "key") {
      return {
        value: credential.key,
        source: connection.type === "env" ? "environment" : "key",
        metadata: credential.metadata,
      }
    }
  }

  return undefined
}

export function credentialSettings(settings: Readonly<Record<string, unknown>>, body: Readonly<Record<string, unknown>>, credential?: ResolvedCredential) {
  const prepared = { ...settings }
  if (prepared.apiKey === "") delete prepared.apiKey
  const metadata = credential?.metadata ?? {}
  const bodyMetadata = Object.fromEntries(Object.entries(metadata).filter(([, value]) => record(value)))
  return {
    settings: { ...prepared, ...metadata },
    body: credential && credential.source !== "oauth" ? mergeOverlay(body, bodyMetadata) : { ...body },
  }
}
