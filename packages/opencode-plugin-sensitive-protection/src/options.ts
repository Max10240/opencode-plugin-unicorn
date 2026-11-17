import os from "node:os"
import path from "node:path"
import { EXTRACT_FORMATS, isExtractFormat, isStructuredFormat, type ExtractFormat } from "./spec.js"

export const DEFAULT_MAX_CONTENT_BYTES = 8 * 1024 * 1024
export const MAX_CONTENT_BYTES_LIMIT = 64 * 1024 * 1024
export const DEFAULT_HISTORY_LIMIT = 200
export const MAX_HISTORY_LIMIT = 1000
export const DEFAULT_HISTORY_KEYBIND = "ctrl+shift+h"

export type FileConfig = {
  readonly path: string
  readonly format: ExtractFormat
  readonly keys: readonly string[]
  readonly label?: string
}

export type ProtectionOptions = {
  readonly enabled?: boolean
  readonly maxContentBytes?: number
  readonly files?: readonly (string | Record<string, unknown>)[]
  readonly notifications?: boolean
  readonly historyLimit?: number
  readonly historyKeybind?: string | false
}

export type ResolvedProtectionOptions = {
  readonly enabled: boolean
  readonly maxContentBytes: number
  readonly dataDirectory: string
  readonly files: readonly FileConfig[]
  readonly exclusions: readonly string[]
  readonly fileErrors: readonly string[]
  readonly notifications: boolean
  readonly historyLimit: number
  readonly historyKeybind: string | false
}

export function dataDirectory(environment: NodeJS.ProcessEnv = process.env, home = os.homedir()) {
  const base = environment.XDG_DATA_HOME || path.join(home, ".local", "share")
  return path.join(base, "opencode", "sensitive-protection")
}

export async function parseProtectionOptions(
  raw: Readonly<Record<string, unknown>> = {},
  _directory: string,
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
  const files = parseFileEntries(raw.files)
  return {
    enabled: raw.enabled !== false,
    maxContentBytes: configured === undefined ? DEFAULT_MAX_CONTENT_BYTES : configured as number,
    dataDirectory: dataDirectory(environment),
    files: files.entries,
    exclusions: files.exclusions,
    fileErrors: files.errors,
    notifications: raw.notifications !== false,
    historyLimit: configuredHistory === undefined ? DEFAULT_HISTORY_LIMIT : configuredHistory as number,
    historyKeybind: raw.historyKeybind === false
      ? false
      : typeof raw.historyKeybind === "string" && raw.historyKeybind.trim()
        ? raw.historyKeybind.trim()
        : DEFAULT_HISTORY_KEYBIND,
  }
}

export function parseFileEntries(raw: unknown): { entries: FileConfig[]; exclusions: string[]; errors: string[] } {
  if (raw === undefined || raw === null) return { entries: [], exclusions: [], errors: [] }
  if (!Array.isArray(raw)) return { entries: [], exclusions: [], errors: ["files must be an array"] }
  const entries: FileConfig[] = []
  const exclusions: string[] = []
  const errors: string[] = []
  for (const [index, item] of raw.entries()) {
    try {
      if (typeof item === "string") {
        const value = item.trim()
        if (!value) continue
        if (!value.startsWith("!")) throw new Error(`files[${index}] string entries must start with ! to exclude a path`)
        const target = value.slice(1).trim()
        if (!target) throw new Error(`files[${index}] exclusion path is empty`)
        exclusions.push(target)
        continue
      }
      if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error(`files[${index}] must be an object`)
      const value = item as Record<string, unknown>
      if (typeof value.path !== "string" || !value.path.trim()) throw new Error(`files[${index}].path must be a non-empty string`)
      if (typeof value.format !== "string" || !isExtractFormat(value.format)) {
        throw new Error(`files[${index}].format must be one of ${EXTRACT_FORMATS.join(", ")}`)
      }
      const keys = parseKeys(value.keys, `files[${index}].keys`)
      if (isStructuredFormat(value.format) && keys.length === 0) {
        throw new Error(`files[${index}].keys must be a non-empty array for ${value.format}`)
      }
      entries.push({
        path: value.path.trim(),
        format: value.format,
        keys,
        ...(typeof value.label === "string" && value.label.trim() ? { label: value.label.trim() } : {}),
      })
    } catch (error) {
      errors.push(error instanceof Error ? error.message : `files[${index}] is invalid`)
    }
  }
  return { entries, exclusions, errors }
}

function parseKeys(value: unknown, name: string): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) {
    throw new Error(`${name} must be an array of non-empty strings`)
  }
  return [...new Set(value.map((item) => item.trim()))]
}
