import { constants as fsConstants } from "node:fs"
import {
  chmod,
  copyFile,
  link,
  lstat,
  mkdir,
  readFile,
  realpath,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises"
import { randomUUID, createPrivateKey, createPublicKey, generateKeyPairSync } from "node:crypto"
import os from "node:os"
import path from "node:path"
import { parsePublicKey, publicKeyFingerprint, type ParsedPublicKey } from "./crypto.js"
import type { ResolvedSensitiveEncryptOptions } from "./options.js"

export const LEGACY_PUBLIC_KEY = "public.pem"
export const LEGACY_PRIVATE_KEY = "private.pem"
export const ENCRYPT_PUBLIC_KEY = "encrypt-public.pem"
export const ENCRYPT_PRIVATE_KEY = "encrypt-private.pem"
export const DECRYPT_PUBLIC_KEY = "decrypt-public.pem"
export const DECRYPT_PRIVATE_KEY = "decrypt-private.pem"
export const MAX_PRIVATE_KEY_BYTES = 32 * 1024

export type DecryptKey = {
  readonly privateKey: string
  readonly path: string
  readonly keyID: string
  readonly publicKey?: string
  readonly publicKeyPath?: string
}

function expandTempLiteral(value: string) {
  const root = path.resolve(os.tmpdir())
  if (value === "$TMPDIR" || value === "${TMPDIR}") return root
  if (value.startsWith("$TMPDIR/")) return path.join(root, value.slice("$TMPDIR/".length))
  if (value.startsWith("${TMPDIR}/")) return path.join(root, value.slice("${TMPDIR}/".length))
  return value
}

function assertInside(root: string, target: string) {
  const relative = path.relative(root, target)
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("Path must be under $TMPDIR")
  }
}

async function tempRoot() {
  return realpath(os.tmpdir())
}

export async function resolveTempInput(value: string) {
  if (typeof value !== "string" || !value.trim()) throw new Error("file must be a non-empty path")
  const candidate = expandTempLiteral(value.trim())
  if (!path.isAbsolute(candidate)) throw new Error("file must be an absolute path or start with $TMPDIR/")
  const root = await tempRoot()
  const resolved = await realpath(candidate).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") throw new Error("File not found")
    throw error
  })
  assertInside(root, resolved)
  return resolved
}

export async function resolveTempOutput(value: string) {
  if (typeof value !== "string" || !value.trim()) throw new Error("out must be a non-empty path")
  const candidate = expandTempLiteral(value.trim())
  if (!path.isAbsolute(candidate)) throw new Error("out must be an absolute path or start with $TMPDIR/")
  const root = await tempRoot()
  const parent = await realpath(path.dirname(candidate)).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") throw new Error("Output directory not found")
    throw error
  })
  assertInside(root, parent)
  const base = path.basename(candidate)
  if (!base || base === "." || base === "..") throw new Error("Invalid output path")
  return path.join(parent, base)
}

export async function readSecretFile(value: string, maxBytes: number) {
  const resolved = await resolveTempInput(value)
  const info = await stat(resolved)
  if (!info.isFile()) throw new Error("file must be a regular file")
  if (info.size > maxBytes) throw new Error(`file exceeds the ${maxBytes} byte limit`)
  if (process.platform !== "win32" && (info.mode & 0o077) !== 0) {
    throw new Error("Secret file must not be readable by group or others; use mktemp or chmod 600")
  }
  return { data: await readFile(resolved), path: resolved }
}

export async function readCiphertextFile(value: string, maxBytes: number) {
  const resolved = await resolveTempInput(value)
  const info = await stat(resolved)
  if (!info.isFile()) throw new Error("file must be a regular file")
  if (info.size > maxBytes) throw new Error(`ciphertext file exceeds the ${maxBytes} byte limit`)
  return { data: await readFile(resolved), path: resolved }
}

async function writeSensitiveFile(value: string, data: string | Buffer, sourcePath: string) {
  const target = await resolveTempOutput(value)
  if (target === sourcePath) throw new Error("out must not overwrite the input file")
  const existing = await lstat(target).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined
    throw error
  })
  if (existing?.isSymbolicLink()) throw new Error("out must not be a symbolic link")
  if (existing && !existing.isFile()) throw new Error("out must be a regular file")

  const directory = path.dirname(target)
  const temporary = path.join(directory, `.${path.basename(target)}.${randomUUID()}.tmp`)
  try {
    await writeFile(temporary, data, { flag: "wx", mode: 0o600 })
    await chmod(temporary, 0o600)
    await rename(temporary, target)
    return target
  } finally {
    await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error
    })
  }
}

export function writeCiphertext(value: string, ciphertext: string, sourcePath: string) {
  return writeSensitiveFile(value, ciphertext, sourcePath)
}

export function writePlaintext(value: string, plaintext: Buffer, sourcePath: string) {
  return writeSensitiveFile(value, plaintext, sourcePath)
}

async function writeTemp(directory: string, content: string, mode: number) {
  const file = path.join(directory, `.key-${randomUUID()}.tmp`)
  await writeFile(file, content, { flag: "wx", mode })
  await chmod(file, mode)
  return file
}

async function publishExclusive(temporary: string, target: string) {
  try {
    await link(temporary, target)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw error
    if (process.platform === "win32" && ["EPERM", "EACCES", "ENOTSUP"].includes((error as NodeJS.ErrnoException).code ?? "")) {
      await copyFile(temporary, target, fsConstants.COPYFILE_EXCL)
      return
    }
    throw error
  }
}

async function ensureDirectory(directory: string) {
  await mkdir(directory, { recursive: true, mode: 0o700 })
  if (!(await stat(directory)).isDirectory()) throw new Error("Key directory is not a directory")
}

async function readIfExists(file: string) {
  return readFile(file).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined
    throw error
  })
}

async function initializePair(directory: string, privateName: string, publicName: string) {
  await ensureDirectory(directory)
  const privatePath = path.join(directory, privateName)
  const publicPath = path.join(directory, publicName)

  const existingPublic = await readIfExists(publicPath)
  if (existingPublic) return { publicKey: existingPublic.toString("utf8"), privatePath, publicPath }

  const existingPrivate = await readIfExists(privatePath)
  if (existingPrivate) throw new Error(`A private key exists but ${publicName} is missing; refusing to overwrite it`)

  const pair = generateKeyPairSync("rsa", {
    modulusLength: 3072,
    publicExponent: 0x10001,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  })

  const privateTemp = await writeTemp(directory, pair.privateKey, 0o600)
  try {
    await publishExclusive(privateTemp, privatePath)
  } finally {
    await unlink(privateTemp).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error
    })
  }

  const publicTemp = await writeTemp(directory, pair.publicKey, 0o644)
  try {
    await publishExclusive(publicTemp, publicPath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      return { publicKey: (await readFile(publicPath)).toString("utf8"), privatePath, publicPath }
    }
    throw error
  } finally {
    await unlink(publicTemp).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error
    })
  }

  return { publicKey: pair.publicKey, privatePath, publicPath }
}

export async function ensureEncryptPublicKey(options: ResolvedSensitiveEncryptOptions): Promise<ParsedPublicKey | undefined> {
  if (!options.encrypt) return undefined
  if (options.publicKey !== undefined) return parsePublicKey(options.publicKey)
  if (options.publicKeyFile !== undefined) {
    const text = await readIfExists(options.publicKeyFile)
    if (text === undefined) throw new Error(`Public key file not found: ${options.publicKeyFile}`)
    return parsePublicKey(text.toString("utf8"))
  }

  const legacy = path.join(options.keyDirectory, LEGACY_PUBLIC_KEY)
  const legacyText = await readIfExists(legacy)
  if (legacyText) return parsePublicKey(legacyText.toString("utf8"))
  const legacyPrivate = await readIfExists(path.join(options.keyDirectory, LEGACY_PRIVATE_KEY))
  if (legacyPrivate) throw new Error("A private key exists but public.pem is missing; refusing to generate a new key pair")

  const pair = await initializePair(options.keyDirectory, ENCRYPT_PRIVATE_KEY, ENCRYPT_PUBLIC_KEY)
  return parsePublicKey(pair.publicKey)
}

async function readPrivateKeyFile(file: string) {
  const info = await lstat(file).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") throw new Error(`Private key file not found: ${file}`)
    throw error
  })
  if (info.isSymbolicLink()) throw new Error("Private key file must not be a symbolic link")
  if (!info.isFile()) throw new Error("Private key file must be a regular file")
  if (info.size > MAX_PRIVATE_KEY_BYTES) throw new Error("Private key file is too large")
  if (process.platform !== "win32" && (info.mode & 0o077) !== 0) {
    throw new Error("Private key file must not be readable by group or others; use chmod 600")
  }
  const value = await readFile(file)
  let key
  try {
    key = createPrivateKey(value)
  } catch {
    throw new Error("Private key file is not a valid PEM or DER private key")
  }
  if (key.asymmetricKeyType !== "rsa") throw new Error("Private key must be RSA")
  const bits = key.asymmetricKeyDetails?.modulusLength ?? 0
  if (bits < 2048 || bits > 8192) throw new Error("RSA private key must be between 2048 and 8192 bits")
  const publicKey = createPublicKey(key).export({ type: "spki", format: "pem" }).toString()
  return {
    privateKey: value.toString("utf8"),
    keyID: publicKeyFingerprint(createPublicKey(key)),
    publicKey,
  }
}

export async function ensureDecryptKey(options: ResolvedSensitiveEncryptOptions): Promise<DecryptKey | undefined> {
  if (!options.decrypt) return undefined
  if (options.privateKeyFile !== undefined) {
    const loaded = await readPrivateKeyFile(options.privateKeyFile)
    return { ...loaded, path: options.privateKeyFile }
  }

  const privatePath = path.join(options.keyDirectory, DECRYPT_PRIVATE_KEY)
  const publicPath = path.join(options.keyDirectory, DECRYPT_PUBLIC_KEY)
  const existing = await readIfExists(privatePath)
  if (existing) {
    const loaded = await readPrivateKeyFile(privatePath)
    return { ...loaded, path: privatePath, publicKeyPath: publicPath }
  }

  const pair = await initializePair(options.keyDirectory, DECRYPT_PRIVATE_KEY, DECRYPT_PUBLIC_KEY)
  const loaded = await readPrivateKeyFile(pair.privatePath)
  return { ...loaded, path: pair.privatePath, publicKeyPath: pair.publicPath }
}

export async function readDecryptKey(file: string): Promise<DecryptKey> {
  const loaded = await readPrivateKeyFile(file)
  return { ...loaded, path: file }
}
