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
import { randomUUID, generateKeyPairSync } from "node:crypto"
import os from "node:os"
import path from "node:path"
import { parsePublicKey, type ParsedPublicKey } from "./crypto.js"
import type { ResolvedSensitiveEncryptOptions } from "./options.js"

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

export async function writeCiphertext(value: string, ciphertext: string, sourcePath: string) {
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
    await writeFile(temporary, ciphertext, { flag: "wx", mode: 0o600 })
    await chmod(temporary, 0o600)
    await rename(temporary, target)
    return target
  } finally {
    await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error
    })
  }
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

async function initializeKeyPair(directory: string): Promise<ParsedPublicKey> {
  await mkdir(directory, { recursive: true, mode: 0o700 })
  if (!(await stat(directory)).isDirectory()) throw new Error("Key directory is not a directory")

  const pair = generateKeyPairSync("rsa", {
    modulusLength: 3072,
    publicExponent: 0x10001,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  })
  const privatePath = path.join(directory, "private.pem")
  const publicPath = path.join(directory, "public.pem")

  const privateTemp = await writeTemp(directory, pair.privateKey, 0o600)
  try {
    await publishExclusive(privateTemp, privatePath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error("A private key exists but public.pem is missing; restore public.pem or move the private key")
    }
    throw error
  } finally {
    await unlink(privateTemp).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error
    })
  }

  const publicTemp = await writeTemp(directory, pair.publicKey, 0o644)
  try {
    await publishExclusive(publicTemp, publicPath)
  } catch (error) {
    await unlink(privatePath).catch(() => {})
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      return parsePublicKey(await readFile(publicPath, "utf8"))
    }
    throw error
  } finally {
    await unlink(publicTemp).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error
    })
  }

  return parsePublicKey(pair.publicKey)
}

export async function ensurePublicKey(options: ResolvedSensitiveEncryptOptions): Promise<ParsedPublicKey> {
  if (options.publicKey !== undefined) return parsePublicKey(options.publicKey)
  if (options.publicKeyFile !== undefined) {
    try {
      return parsePublicKey(await readFile(options.publicKeyFile, "utf8"))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error(`Public key file not found: ${options.publicKeyFile}`)
      }
      throw error
    }
  }

  const publicPath = path.join(options.keyDirectory, "public.pem")
  try {
    return parsePublicKey(await readFile(publicPath, "utf8"))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
  }
  return initializeKeyPair(options.keyDirectory)
}
