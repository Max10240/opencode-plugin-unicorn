import { expect, test } from "bun:test"
import { generateKeyPairSync } from "node:crypto"
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { parseOptions } from "../src/options.js"
import { ensurePublicKey, readSecretFile, resolveTempInput, writeCiphertext } from "../src/paths.js"

async function fixture(run: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "sensitive-encrypt-paths-"))
  try { await run(directory) } finally { await rm(directory, { recursive: true, force: true }) }
}

function literal(directory: string, file = "") {
  const relative = path.relative(os.tmpdir(), path.join(directory, file)).split(path.sep).join("/")
  return `$TMPDIR/${relative}`
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

test("writes ciphertext atomically, overwrites regular files, and refuses unsafe targets", async () => {
  await fixture(async (directory) => {
    const source = path.join(directory, "secret.txt")
    const out = path.join(directory, "secret.ocsec")
    await writeFile(source, "SECRET", { mode: 0o600 })
    const sourcePath = await resolveTempInput(literal(directory, "secret.txt"))
    const target = await writeCiphertext(literal(directory, "secret.ocsec"), "FIRST", sourcePath)
    expect(target).toBe(await resolveTempInput(out))
    expect(await readFile(out, "utf8")).toBe("FIRST")
    expect((await stat(out)).mode & 0o777).toBe(0o600)

    await writeFile(out, "OLD", { mode: 0o644 })
    await writeCiphertext(literal(directory, "secret.ocsec"), "SECOND", sourcePath)
    expect(await readFile(out, "utf8")).toBe("SECOND")
    expect((await stat(out)).mode & 0o777).toBe(0o600)

    await expect(writeCiphertext(literal(directory, "secret.txt"), "SAME", sourcePath)).rejects.toThrow("must not overwrite")
    await expect(writeCiphertext(literal(directory, "missing/secret.ocsec"), "X", sourcePath)).rejects.toThrow("Output directory")
    await expect(writeCiphertext("/tmp/not-allowed.ocsec", "X", sourcePath)).rejects.toThrow("under $TMPDIR")

    const link = path.join(directory, "out-link")
    await symlink(out, link)
    await expect(writeCiphertext(literal(directory, "out-link"), "X", sourcePath)).rejects.toThrow("symbolic link")

    await mkdir(path.join(directory, "out-dir"))
    await expect(writeCiphertext(literal(directory, "out-dir"), "X", sourcePath)).rejects.toThrow("regular file")
  })
})

test("initializes one pair only when the default public key is absent", async () => {
  await fixture(async (directory) => {
    const options = parseOptions({ keyDirectory: directory })
    const key = await ensurePublicKey(options)
    expect(key.kid).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect((await stat(path.join(directory, "private.pem"))).mode & 0o777).toBe(0o600)
    expect((await stat(path.join(directory, "public.pem"))).mode & 0o777).toBe(0o644)

    const publicText = await readFile(path.join(directory, "public.pem"), "utf8")
    await rm(path.join(directory, "private.pem"))
    expect((await ensurePublicKey(options)).kid).toBe(key.kid)
    expect(await readFile(path.join(directory, "public.pem"), "utf8")).toBe(publicText)
    await expect(stat(path.join(directory, "private.pem"))).rejects.toThrow()
  })
})

test("never reads or overwrites an existing private key when the public key is missing", async () => {
  await fixture(async (directory) => {
    const options = parseOptions({ keyDirectory: directory })
    const privateFile = path.join(directory, "private.pem")
    await writeFile(privateFile, "DO_NOT_READ", { mode: 0o600 })
    await expect(ensurePublicKey(options)).rejects.toThrow("private key exists")
    expect(await readFile(privateFile, "utf8")).toBe("DO_NOT_READ")
    await expect(stat(path.join(directory, "public.pem"))).rejects.toThrow()
  })
})

test("does not replace an invalid existing public key and respects explicit missing keys", async () => {
  await fixture(async (directory) => {
    const options = parseOptions({ keyDirectory: directory })
    await writeFile(path.join(directory, "public.pem"), "NOT_A_KEY")
    await expect(ensurePublicKey(options)).rejects.toThrow()
    expect(await readFile(path.join(directory, "public.pem"), "utf8")).toBe("NOT_A_KEY")

    const missing = path.join(directory, "missing.pem")
    const explicit = parseOptions({ publicKeyFile: missing, keyDirectory: path.join(directory, "keys") })
    await expect(ensurePublicKey(explicit)).rejects.toThrow("not found")
    await expect(stat(path.join(directory, "keys"))).rejects.toThrow()
  })
})

test("uses configured inline and file public keys without generating a pair", async () => {
  await fixture(async (directory) => {
    const pair = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    })
    const publicFile = path.join(directory, "configured-public.pem")
    await writeFile(publicFile, pair.publicKey)
    const inline = await ensurePublicKey(parseOptions({ publicKey: pair.publicKey, keyDirectory: path.join(directory, "inline-keys") }))
    const fromFile = await ensurePublicKey(parseOptions({ publicKeyFile: publicFile, keyDirectory: path.join(directory, "file-keys") }))
    expect(fromFile.kid).toBe(inline.kid)
    await expect(stat(path.join(directory, "inline-keys"))).rejects.toThrow()
    await expect(stat(path.join(directory, "file-keys"))).rejects.toThrow()
  })
})
