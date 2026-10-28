import os from "node:os"
import path from "node:path"

export const DEFAULT_KEY_DIRECTORY = "sensitive-encrypt"
export const DEFAULT_MAX_BYTES = 1024 * 1024
export const MAX_BYTES_LIMIT = 64 * 1024 * 1024
export const MAX_INLINE_CIPHERTEXT_BYTES = 256 * 1024

export type SensitiveEncryptOptions = {
  readonly enabled?: boolean
  readonly encrypt?: boolean | null
  readonly decrypt?: boolean | null
  readonly publicKeyForEncrypt?: string
  readonly publicKeyFileForEncrypt?: string
  readonly privateKeyFileForDecrypt?: string
  readonly publicKey?: string
  readonly publicKeyFile?: string
  // Silently supported for existing configurations; new docs do not use it.
  readonly keyDirectory?: string
  readonly maxBytes?: number
}

export type ResolvedSensitiveEncryptOptions = {
  readonly enabled: boolean
  readonly encrypt: boolean
  readonly decrypt: boolean
  readonly publicKey?: string
  readonly publicKeyFile?: string
  readonly privateKeyFile?: string
  readonly keyDirectory: string
  readonly maxBytes: number
}

export function globalConfigDirectory(
  environment: NodeJS.ProcessEnv = process.env,
  home = os.homedir(),
) {
  return path.resolve(
    environment.OPENCODE_CONFIG_DIR ||
      path.join(environment.XDG_CONFIG_HOME || path.join(home, ".config"), "opencode"),
  )
}

export function resolveConfigPath(value: string, base = globalConfigDirectory()) {
  if (value === "~") return os.homedir()
  if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2))
  return path.isAbsolute(value) ? path.resolve(value) : path.resolve(base, value)
}

export function parseOptions(
  raw: Readonly<Record<string, unknown>> = {},
  environment: NodeJS.ProcessEnv = process.env,
): ResolvedSensitiveEncryptOptions {
  const publicKey = raw.publicKeyForEncrypt ?? raw.publicKey
  const publicKeyFile = raw.publicKeyFileForEncrypt ?? raw.publicKeyFile
  const privateKeyFile = raw.privateKeyFileForDecrypt
  const keyDirectory = raw.keyDirectory

  if (publicKey !== undefined && publicKeyFile !== undefined) {
    throw new Error("publicKeyForEncrypt and publicKeyFileForEncrypt cannot be used together")
  }
  if (publicKey !== undefined && (typeof publicKey !== "string" || !publicKey.trim())) {
    throw new Error("publicKeyForEncrypt must be a non-empty PEM or base64 DER string")
  }
  if (publicKeyFile !== undefined && (typeof publicKeyFile !== "string" || !publicKeyFile.trim())) {
    throw new Error("publicKeyFileForEncrypt must be a non-empty path")
  }
  if (privateKeyFile !== undefined && (typeof privateKeyFile !== "string" || !privateKeyFile.trim())) {
    throw new Error("privateKeyFileForDecrypt must be a non-empty path")
  }
  if (keyDirectory !== undefined && (typeof keyDirectory !== "string" || !keyDirectory.trim())) {
    throw new Error("keyDirectory must be a non-empty path")
  }

  const configuredMaxBytes = raw.maxBytes
  if (configuredMaxBytes !== undefined && (typeof configuredMaxBytes !== "number" || !Number.isSafeInteger(configuredMaxBytes) || configuredMaxBytes < 1 || configuredMaxBytes > MAX_BYTES_LIMIT)) {
    throw new Error(`maxBytes must be an integer between 1 and ${MAX_BYTES_LIMIT}`)
  }
  const maxBytes = configuredMaxBytes === undefined ? DEFAULT_MAX_BYTES : configuredMaxBytes as number

  const enabled = raw.enabled !== false
  const encrypt = enabled && raw.encrypt !== false && raw.encrypt !== null
  const decrypt = enabled && raw.decrypt !== false && raw.decrypt !== null
  const configDirectory = globalConfigDirectory(environment)

  return {
    enabled,
    encrypt,
    decrypt,
    ...(typeof publicKey === "string" ? { publicKey } : {}),
    ...(typeof publicKeyFile === "string" ? { publicKeyFile: resolveConfigPath(publicKeyFile, configDirectory) } : {}),
    ...(typeof privateKeyFile === "string" ? { privateKeyFile: resolveConfigPath(privateKeyFile, configDirectory) } : {}),
    keyDirectory: typeof keyDirectory === "string"
      ? resolveConfigPath(keyDirectory, configDirectory)
      : path.join(configDirectory, DEFAULT_KEY_DIRECTORY),
    maxBytes,
  }
}
