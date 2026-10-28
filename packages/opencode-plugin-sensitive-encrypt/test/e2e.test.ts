import { expect, setDefaultTimeout, test } from "bun:test"
import { generateKeyPairSync, randomUUID } from "node:crypto"
import { access, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createOpenCodeE2E } from "../../opencode-plugin-unicorn/test/e2e-utils.js"
import { api, createSession, prompt, waitFor } from "../../opencode-plugin-show-img/test/e2e-utils.js"
import { encryptEnvelope, parsePublicKey } from "../src/crypto.js"

setDefaultTimeout(180_000)

function literal(file: string) {
  return `$TMPDIR/${path.relative(os.tmpdir(), file).split(path.sep).join("/")}`
}

async function callTool(
  e2e: Awaited<ReturnType<typeof createOpenCodeE2E>>,
  message: string,
  tool: string,
  argumentsValue: Record<string, unknown>,
) {
  const id = `call_${randomUUID()}`
  e2e.proxy.mock.prependFixture({
    match: { userMessage: message, toolName: tool, hasToolResult: false },
    response: { toolCalls: [{ id, name: tool, arguments: JSON.stringify(argumentsValue) }] },
  })
  e2e.proxy.mock.prependFixture({ match: { toolCallId: id }, response: { content: `${message}_DONE` } })
  const sessionID = await createSession(e2e)
  await prompt(e2e, sessionID, message)
  const exported = await api<{ data: { messages: Array<Record<string, any>> } }>(
    e2e,
    `/api/experimental/session/${sessionID}/export`,
  )
  return exported.data.messages
    .flatMap((entry) => entry.content ?? [])
    .find((entry) => entry.type === "tool" && entry.id === id)
}

test("encrypts and decrypts independent temp files in real OpenCode", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sensitive-encrypt-e2e-"))
  const secret = path.join(root, "secret.txt")
  const ciphertext = path.join(root, "secret.ocsec")
  const plaintext = path.join(root, "plain.txt")
  await writeFile(secret, "SECRET_ONE_MARKER", { mode: 0o600 })

  const e2e = await createOpenCodeE2E({
    plugin: "sensitive-encrypt",
    pluginPackage: path.resolve(import.meta.dir, "../dist"),
    pluginOptions: {},
  })
  const keyDirectory = path.join(e2e.configDirectory, "sensitive-encrypt")
  try {
    await e2e.waitForModelContext(200_000)
    const encryptPublic = path.join(keyDirectory, "encrypt-public.pem")
    const decryptPrivate = path.join(keyDirectory, "decrypt-private.pem")
    const decryptPublic = path.join(keyDirectory, "decrypt-public.pem")
    await waitFor(async () => {
      await access(encryptPublic)
      await access(decryptPrivate)
      await access(decryptPublic)
      return true
    }, "Independent key pairs were not initialized")
    if (process.platform !== "win32") {
      expect((await stat(path.join(keyDirectory, "encrypt-private.pem"))).mode & 0o777).toBe(0o600)
      expect((await stat(decryptPrivate)).mode & 0o777).toBe(0o600)
    }

    const encrypted = await callTool(e2e, "ENCRYPT_ONE", "encrypt_sensitive", {
      file: literal(secret),
      out: literal(ciphertext),
    })
    expect(encrypted?.state.status).toBe("completed")
    expect(JSON.stringify(encrypted)).not.toContain("SECRET_ONE_MARKER")
    expect(await readFile(ciphertext, "utf8")).toStartWith("ocsec1:")

    // The decrypt key pair is independent, so build an envelope for its public key.
    await writeFile(
      path.join(root, "incoming.ocsec"),
      encryptEnvelope(parsePublicKey(await readFile(decryptPublic, "utf8")), Buffer.from("SECRET_TWO_MARKER")),
      { mode: 0o600 },
    )
    const decrypted = await callTool(e2e, "DECRYPT_TWO", "decrypt_sensitive", {
      file: literal(path.join(root, "incoming.ocsec")),
      out: literal(plaintext),
    })
    expect(decrypted?.state.status).toBe("completed")
    expect(JSON.stringify(decrypted)).not.toContain("SECRET_TWO_MARKER")
    expect(await readFile(plaintext, "utf8")).toBe("SECRET_TWO_MARKER")
    expect((await stat(plaintext)).mode & 0o777).toBe(0o600)
    expect(JSON.stringify(e2e.proxy.requests)).not.toContain("SECRET_ONE_MARKER")
    expect(JSON.stringify(e2e.proxy.requests)).not.toContain("SECRET_TWO_MARKER")
  } finally {
    await e2e.close()
    await rm(root, { recursive: true, force: true })
  }
})

test("Unicorn loads local encryption with the configured encrypt public key", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sensitive-encrypt-unicorn-e2e-"))
  const secret = path.join(root, "secret.txt")
  const out = path.join(root, "secret.ocsec")
  const publicKeyFile = path.join(root, "public.pem")
  const { publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 3072,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  })
  await writeFile(publicKeyFile, publicKey, { mode: 0o644 })
  await writeFile(secret, "UNICORN_SECRET_MARKER", { mode: 0o600 })

  const e2e = await createOpenCodeE2E({
    plugin: "unicorn",
    pluginPackage: path.resolve(import.meta.dir, "../../opencode-plugin-unicorn"),
    pluginOptions: {
      features: {
        recommendedOpencodeConfig: false,
        sendMessageAcrossSessions: false,
        imageGen: false,
        showImg: false,
        promptSearch: false,
        sessionSearch: false,
      },
      sensitiveEncrypt: { publicKeyFileForEncrypt: publicKeyFile, decrypt: false },
    },
  })
  try {
    await e2e.waitForModelContext(200_000)
    const part = await callTool(e2e, "UNICORN_ENCRYPT", "encrypt_sensitive", {
      file: literal(secret),
      out: literal(out),
    })
    expect(part?.state.status).toBe("completed")
    expect(JSON.stringify(part)).not.toContain("UNICORN_SECRET_MARKER")
    expect(e2e.proxy.requests.some((request) => request.tools.includes("encrypt_sensitive"))).toBe(true)
    expect(e2e.proxy.requests.some((request) => request.tools.includes("decrypt_sensitive"))).toBe(false)
    const ciphertext = await readFile(out, "utf8")
    expect(ciphertext).toStartWith("ocsec1:")
  } finally {
    await e2e.close()
    await rm(root, { recursive: true, force: true })
  }
})
