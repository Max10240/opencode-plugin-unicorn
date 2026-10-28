import os from "node:os"
import path from "node:path"
import { readFile } from "node:fs/promises"

export const DEFAULT_MAX_CONTENT_BYTES = 8 * 1024 * 1024
export const MAX_CONTENT_BYTES_LIMIT = 64 * 1024 * 1024

export type ProtectionOptions = {
  readonly enabled?: boolean
  readonly blockReads?: boolean
  readonly redactContext?: boolean
  readonly redactHttp?: boolean
  readonly maxContentBytes?: number
}

export type ResolvedProtectionOptions = {
  readonly enabled: boolean
  readonly blockReads: boolean
  readonly redactContext: boolean
  readonly redactHttp: boolean
  readonly maxContentBytes: number
  readonly dataDirectory: string
}

export function dataDirectory(environment: NodeJS.ProcessEnv = process.env, home = os.homedir()) {
  const base = environment.XDG_DATA_HOME || path.join(home, ".local", "share")
  return path.join(base, "opencode", "sensitive-protection")
}

export async function projectEscapeHatch(directory: string) {
  const file = path.join(directory, ".opencode", "sensitive-protection.json")
  try {
    const parsed = JSON.parse(await readFile(file, "utf8")) as unknown
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return true
    const value = parsed as Record<string, unknown>
    if (value.enabled === false || value.disabled === true) return false
    return true
  } catch {
    return true
  }
}

export async function parseProtectionOptions(
  raw: Readonly<Record<string, unknown>> = {},
  directory: string,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<ResolvedProtectionOptions> {
  const configured = raw.maxContentBytes
  if (configured !== undefined && (typeof configured !== "number" || !Number.isSafeInteger(configured) || configured < 1 || configured > MAX_CONTENT_BYTES_LIMIT)) {
    throw new Error(`maxContentBytes must be an integer between 1 and ${MAX_CONTENT_BYTES_LIMIT}`)
  }
  const enabled = raw.enabled !== false && (await projectEscapeHatch(directory))
  return {
    enabled,
    blockReads: raw.blockReads !== false,
    redactContext: raw.redactContext !== false,
    redactHttp: raw.redactHttp !== false,
    maxContentBytes: configured === undefined ? DEFAULT_MAX_CONTENT_BYTES : configured as number,
    dataDirectory: dataDirectory(environment),
  }
}
