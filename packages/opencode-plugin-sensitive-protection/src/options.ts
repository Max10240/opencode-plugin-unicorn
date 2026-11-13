import os from "node:os"
import path from "node:path"
import { readFile } from "node:fs/promises"

export const DEFAULT_MAX_CONTENT_BYTES = 8 * 1024 * 1024
export const MAX_CONTENT_BYTES_LIMIT = 64 * 1024 * 1024
export const DEFAULT_HISTORY_LIMIT = 200
export const MAX_HISTORY_LIMIT = 1000
export const DEFAULT_HISTORY_KEYBIND = "ctrl+shift+h"

export type ExtractFormat = "json" | "yaml" | "ini" | "toml"
export type ReadPolicy = "block" | "redact"
export type WritePolicy = "allow" | "block"

export type CustomFileOptions = {
  readonly id: string
  readonly path: string
  readonly label: string
  readonly format?: ExtractFormat
  readonly fields?: readonly string[]
  readonly extractor?: string
  readonly read: ReadPolicy
  readonly write: WritePolicy
}

export type ProtectionOptions = {
  readonly enabled?: boolean
  readonly blockReads?: boolean
  readonly redactContext?: boolean
  readonly redactHttp?: boolean
  readonly maxContentBytes?: number
  readonly builtins?: boolean
  readonly disabledBuiltinGroups?: readonly string[]
  readonly customFiles?: readonly CustomFileOptions[]
  readonly allowCustomExtractors?: boolean
  readonly notifications?: boolean
  readonly historyLimit?: number
  readonly historyKeybind?: string | false
}

export type ResolvedProtectionOptions = {
  readonly enabled: boolean
  readonly blockReads: boolean
  readonly redactContext: boolean
  readonly redactHttp: boolean
  readonly maxContentBytes: number
  readonly dataDirectory: string
  readonly builtins: boolean
  readonly disabledBuiltinGroups: ReadonlySet<string>
  readonly customFiles: readonly CustomFileOptions[]
  readonly customFileErrors: readonly string[]
  readonly allowCustomExtractors: boolean
  readonly notifications: boolean
  readonly historyLimit: number
  readonly historyKeybind: string | false
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
  const configuredHistory = raw.historyLimit
  if (configuredHistory !== undefined && (typeof configuredHistory !== "number" || !Number.isSafeInteger(configuredHistory) || configuredHistory < 0 || configuredHistory > MAX_HISTORY_LIMIT)) {
    throw new Error(`historyLimit must be an integer between 0 and ${MAX_HISTORY_LIMIT}`)
  }
  const enabled = raw.enabled !== false && (await projectEscapeHatch(directory))
  const custom = parseCustomFiles(raw.customFiles, raw.allowCustomExtractors === true)
  return {
    enabled,
    blockReads: raw.blockReads !== false,
    redactContext: raw.redactContext !== false,
    redactHttp: raw.redactHttp !== false,
    maxContentBytes: configured === undefined ? DEFAULT_MAX_CONTENT_BYTES : configured as number,
    dataDirectory: dataDirectory(environment),
    builtins: raw.builtins !== false,
    disabledBuiltinGroups: new Set(parseStringArray(raw.disabledBuiltinGroups)),
    customFiles: custom.files,
    customFileErrors: custom.errors,
    allowCustomExtractors: raw.allowCustomExtractors === true,
    notifications: raw.notifications !== false,
    historyLimit: configuredHistory === undefined ? DEFAULT_HISTORY_LIMIT : configuredHistory as number,
    historyKeybind: raw.historyKeybind === false
      ? false
      : typeof raw.historyKeybind === "string" && raw.historyKeybind.trim()
        ? raw.historyKeybind.trim()
        : DEFAULT_HISTORY_KEYBIND,
  }
}

export function parseCustomFiles(raw: unknown, allowExtractors: boolean): { files: CustomFileOptions[]; errors: string[] } {
  if (raw === undefined || raw === null) return { files: [], errors: [] }
  if (!Array.isArray(raw)) return { files: [], errors: ["customFiles must be an array"] }
  const files: CustomFileOptions[] = []
  const errors: string[] = []
  for (const [index, item] of raw.entries()) {
    try {
      if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error(`customFiles[${index}] must be an object`)
      const value = item as Record<string, unknown>
      if (typeof value.path !== "string" || !value.path.trim()) throw new Error(`customFiles[${index}].path must be a non-empty string`)
      const format = value.format
      if (format !== undefined && format !== "json" && format !== "yaml" && format !== "ini" && format !== "toml") {
        throw new Error(`customFiles[${index}].format must be json, yaml, ini, or toml`)
      }
      const fields = value.fields === undefined ? undefined : parseStringArray(value.fields, `customFiles[${index}].fields`)
      const extractor = typeof value.extractor === "string" && value.extractor.trim() ? value.extractor : undefined
      if (extractor && !allowExtractors) throw new Error(`customFiles[${index}].extractor requires allowCustomExtractors: true`)
      if (!extractor && !format) throw new Error(`customFiles[${index}] needs format or extractor`)
      if (!extractor && !fields?.length) throw new Error(`customFiles[${index}] needs fields when format is used`)
      if (extractor && format) throw new Error(`customFiles[${index}] cannot use format and extractor together`)
      files.push({
        id: `custom-${index}`,
        path: value.path.trim(),
        label: typeof value.label === "string" && value.label.trim() ? value.label.trim() : value.path.trim(),
        ...(format === undefined ? {} : { format }),
        ...(fields === undefined ? {} : { fields }),
        ...(extractor === undefined ? {} : { extractor }),
        read: value.read === "block" ? "block" : "redact",
        write: value.write === "allow" ? "allow" : "block",
      })
    } catch (error) {
      errors.push(error instanceof Error ? error.message : `customFiles[${index}] is invalid`)
    }
  }
  return { files, errors }
}

function parseStringArray(value: unknown, name = "value"): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) {
    throw new Error(`${name} must be an array of non-empty strings`)
  }
  return [...new Set(value.map((item) => item.trim()))]
}
