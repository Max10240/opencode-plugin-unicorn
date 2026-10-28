import { expect, test } from "bun:test"
import { generateKeyPairSync } from "node:crypto"
import { chmod, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { parseOptions } from "../src/options.js"
import {
  ensureDecryptKey,
  ensureEncryptPublicKey,
  readSecretFile,
  resolveTempInput,
  writeCiphertext,
} from "../src/paths.js"

async function fixture(run: (directory: string, config: string) => Promise<void>) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "sensitive-encrypt-paths-"))
  try { await run(directory, path.join(directory, "config")) } finally { await rm(directory, { recursive: true, force: true }) }
}

function literal(directory: string, file = "") {
  const relative = path.relative(os.tmpdir(), path.join(directory, file)).split(path.sep).join("/")
  return `$TMPDIR/${relative}`
}

function options(config: string) {
  return parseOptions({}, { OPENCODE_CONFIG_DIR: config })
}

test("reads only owner-only regular files under the system temp directory", async () => {
  await fixture(async (directory) => {
    const file = path.join(directory, "secret.txt")
    await writeFile(file, "SECRET", { mode: 0o600 })
    const result = await readSecretFile(literal(directory, "secret.txt"), 1024)
    expect(result.path).toBe(await resolveTempInput(literal(directory, "secret.txt")))
    expect(result.data.toString()).toBe("SECRET")

    await chmod(file, 0o644)
    if (process.platform !== "win32") await expect(readSecretFile(literal(directory, "secret.txt"), 1024)).rejects.toThrow("group or others")
    await chmod(file, 0o600)
    await expect(readSecretFile(literal(directory, "secret.txt"), 3)).rejects.toThrow("exceeds")
    await expect(readSecretFile("/etc/hosts", 1024)).rejects.toThrow("under $TMPDIR")
    await expect(readSecretFile("relative.txt", 1024)).rejects.toThrow("absolute")
    await expect(readSecretFile(literal(directory, "missing.txt"), 1024)).rejects.toThrow("not found")
  })
})

test("rejects symlink escapes and non-file inputs", async () => {
  await fixture(async (directory) => {
    if (process.platform === "win32") return
    const link = path.join(directory, "link.txt")
    await symlink("/etc/hosts", link)
    await expect(readSecretFile(literal(directory, "link.txt"), 1024)).rejects.toThrow("under $TMPDIR")
    await expect(readSecretFile(literal(directory), 1024)).rejects.toThrow("regular file")
  })
})

test("writes ciphertext atomically and refuses unsafe targets", async () => {
  await fixture(async (directory) => {
    const source = path.join(directory, "secret.txt")
    const out = path.join(directory, "secret.ocsec")
    await writeFile(source, "SECRET", { mode: 0o600 })
    const sourcePath = await resolveTempInput(literal(directory, "secret.txt"))
    const target = await writeCiphertext(literal(directory, "secret.ocsec"), "FIRST", sourcePath)
    expect(target).toBe(await resolveTempInput(out))
    expect(await readFile(out, "utf8")).toBe("FIRST")
    expect((await stat(out)).mode & 0o777).toBe(0o600)

    await expect(writeCiphertext(literal(directory, "secret.txt"), "SAME", sourcePath)).rejects.toThrow("must not overwrite")
    await expect(writeCiphertext("/tmp/not-allowed.ocsec", "X", sourcePath)).rejects.toThrow("under $TMPDIR")
  })
})

test("generates independent encrypt and decrypt key pairs", async () => {
  await fixture(async (_directory, config) => {
    const opts = options(config)
    const encryptKey = await ensureEncryptPublicKey(opts)
    const decryptKey = await ensureDecryptKey(opts)
    const keyDirectory = path.join(config, "sensitive-encrypt")
    expect(encryptKey?.kid).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(decryptKey?.keyID).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(encryptKey?.kid).not.toBe(decryptKey?.keyID)
    expect((await stat(path.join(keyDirectory, "encrypt-private.pem"))).mode & 0o777).toBe(0o600)
    expect((await stat(path.join(keyDirectory, "encrypt-public.pem"))).mode & 0o777).toBe(0o644)
    expect((await stat(path.join(keyDirectory, "decrypt-private.pem"))).mode & 0o777).toBe(0o600)
    expect((await stat(path.join(keyDirectory, "decrypt-public.pem"))).mode & 0o777).toBe(0o644)
  })
})

test("uses a legacy public.pem for encryption and requires an explicit private key for decryption", async () => {
  await fixture(async (_directory, config) => {
    const keyDirectory = path.join(config, "sensitive-encrypt")
    const pair = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    })
    const { mkdir } = await import("node:fs/promises")
    await mkdir(keyDirectory, { recursive: true })
    await writeFile(path.join(keyDirectory, "public.pem"), pair.publicKey)
    const opts = options(config)
    const publicKey = await ensureEncryptPublicKey(opts)
    expect(publicKey?.kid).toMatch(/^[A-Za-z0-9_-]{43}$/)
    await expect(stat(path.join(keyDirectory, "encrypt-public.pem"))).rejects.toThrow()

    const privateFile = path.join(keyDirectory, "custom-private.pem")
    await writeFile(privateFile, pair.privateKey, { mode: 0o600 })
    const explicit = parseOptions({ privateKeyFileForDecrypt: privateFile }, { OPENCODE_CONFIG_DIR: config })
    const decryptKey = await ensureDecryptKey(explicit)
    expect(decryptKey?.keyID).toBe(publicKey?.kid)
  })
})

test("rejects private key files with unsafe permissions", async () => {
  await fixture(async (_directory, config) => {
    const pair = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    })
    const { mkdir } = await import("node:fs/promises")
    await mkdir(config, { recursive: true })
    const file = path.join(config, "private.pem")
    await writeFile(file, pair.privateKey, { mode: 0o644 })
    if (process.platform !== "win32") {
      const opts = parseOptions({ privateKeyFileForDecrypt: file }, { OPENCODE_CONFIG_DIR: config })
      await expect(ensureDecryptKey(opts)).rejects.toThrow("group or others")
    }
  })
})
