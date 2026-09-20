import { applyEdits, modify, parse, type ParseError } from "jsonc-parser"
import os from "node:os"
import path from "node:path"
import { mkdir, readFile, stat, writeFile } from "node:fs/promises"

export const GLOBAL_CONFIG_FILE_NAMES = ["opencode.json", "opencode.jsonc"] as const

export const GLOBAL_CONFIG_PATCH = {
  modelID: "gpt-5.6-luna",
  limit: {
    context: 1_000_000,
    input: 922_000,
    output: 128_000,
  },
  share: "disabled" as const,
}

const formattingOptions = {
  tabSize: 2,
  insertSpaces: true,
  eol: "\n" as const,
}

type JsonObject = Record<string, unknown>

export interface GlobalConfigEnvironment {
  readonly OPENCODE_CONFIG_DIR?: string
  readonly XDG_CONFIG_HOME?: string
}

export interface GlobalConfigOptions {
  readonly configDirectory?: string
  readonly environment?: GlobalConfigEnvironment
  readonly homeDirectory?: string
}

export interface GlobalConfigUpdateResult {
  readonly path: string
  readonly changed: boolean
}

/**
 * Resolve the same global config directory used by OpenCode's Node runtime.
 * OPENCODE_CONFIG_DIR has precedence over the XDG default.
 */
export function globalConfigDirectory(options: Pick<GlobalConfigOptions, "environment" | "homeDirectory"> = {}) {
  const environment = options.environment ?? process.env
  if (environment.OPENCODE_CONFIG_DIR) return path.resolve(environment.OPENCODE_CONFIG_DIR)

  const configRoot = environment.XDG_CONFIG_HOME ?? path.join(options.homeDirectory ?? os.homedir(), ".config")
  return path.resolve(configRoot, "opencode")
}

/**
 * Apply the first global configuration feature without rewriting unrelated JSONC.
 * Existing share policies are deliberately preserved; missing share means sharing
 * is disabled in V2, whose schema uses "disabled" rather than boolean false.
 */
export function updateGlobalConfigText(text: string): string {
  const document = parseJsonObject(text)
  let updated = text

  if (!Object.prototype.hasOwnProperty.call(document, "share")) {
    updated = applyEdits(updated, modify(updated, ["share"], GLOBAL_CONFIG_PATCH.share, { formattingOptions }))
  }

  const modelPath = ["providers", "openai", "models", GLOBAL_CONFIG_PATCH.modelID, "limit"]
  for (const [key, value] of Object.entries(GLOBAL_CONFIG_PATCH.limit)) {
    updated = applyEdits(updated, modify(updated, [...modelPath, key], value, { formattingOptions }))
  }

  return updated
}

/**
 * Update the highest-precedence global config file, matching OpenCode's
 * opencode.json/opencode.jsonc selection order.
 */
export async function updateGlobalConfig(options: GlobalConfigOptions = {}): Promise<GlobalConfigUpdateResult> {
  const directory = path.resolve(
    options.configDirectory ?? globalConfigDirectory({ environment: options.environment, homeDirectory: options.homeDirectory }),
  )

  return withDirectoryLock(directory, async () => {
    const configPath = await resolveGlobalConfigPath(directory)
    const original = await readFile(configPath, "utf8").catch((error: unknown) => {
      if (isMissingFile(error)) return "{}\n"
      throw error
    })
    const updated = updateGlobalConfigText(original)

    if (updated !== original) {
      await mkdir(path.dirname(configPath), { recursive: true })
      await writeFile(configPath, updated.endsWith("\n") ? updated : `${updated}\n`, "utf8")
    }

    return { path: configPath, changed: updated !== original }
  })
}

export async function resolveGlobalConfigPath(directory: string): Promise<string> {
  const existing = [] as string[]
  for (const name of GLOBAL_CONFIG_FILE_NAMES) {
    const candidate = path.join(directory, name)
    if (await isFile(candidate)) existing.push(candidate)
  }

  return existing.at(-1) ?? path.join(directory, "opencode.jsonc")
}

function parseJsonObject(text: string): JsonObject {
  const errors: ParseError[] = []
  const value = parse(text, errors, { allowTrailingComma: true })
  if (errors.length > 0) {
    throw new Error(`Cannot update global OpenCode config: invalid JSONC at error offset ${errors[0]?.offset ?? 0}`)
  }
  if (!isJsonObject(value)) throw new Error("Cannot update global OpenCode config: the root value must be an object")
  return value
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isMissingFile(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT"
}

async function isFile(file: string) {
  return stat(file).then(
    (info) => info.isFile(),
    (error: unknown) => {
      if (isMissingFile(error)) return false
      throw error
    },
  )
}

const locks = new Map<string, Promise<unknown>>()

async function withDirectoryLock<T>(directory: string, task: () => Promise<T>): Promise<T> {
  const previous = locks.get(directory) ?? Promise.resolve()
  const current = previous.catch(() => undefined).then(task)
  locks.set(directory, current)

  try {
    return await current
  } finally {
    if (locks.get(directory) === current) locks.delete(directory)
  }
}
