import { expect, test } from "bun:test"
import type { Context } from "@opencode/plugin/promise/plugin"
import type { Info, ToolContext, ToolEditor } from "@opencode/plugin/promise/tool"
import { generateKeyPairSync, randomUUID } from "node:crypto"
import { chmod, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { decryptEnvelope, encryptEnvelope, ENVELOPE_PREFIX, parsePublicKey } from "../src/crypto.js"
import {
  DECRYPT_TOOL_DESCRIPTION,
  DECRYPT_TOOL_NAME,
  KEY_INFO_TOOL_NAME,
  setupSensitiveEncrypt,
  TOOL_DESCRIPTION,
  TOOL_NAME,
} from "../src/index.js"

function literal(directory: string, file = "") {
  return `$TMPDIR/${path.relative(os.tmpdir(), path.join(directory, file)).split(path.sep).join("/")}`
}

function pair() {
  return generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  })
}

async function fixture(run: (value: {
  directory: string
  secret: string
  options: Record<string, unknown>
  encrypt: ReturnType<typeof pair>
  decrypt: ReturnType<typeof pair>
}) => Promise<void>) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "sensitive-encrypt-tool-"))
  const secret = path.join(directory, "secret.txt")
  const encrypt = pair()
  const decrypt = pair()
  const encryptPublic = path.join(directory, "encrypt-public.pem")
  const decryptPrivate = path.join(directory, "decrypt-private.pem")
  await writeFile(encryptPublic, encrypt.publicKey, { mode: 0o644 })
  await writeFile(decryptPrivate, decrypt.privateKey, { mode: 0o600 })
  await writeFile(secret, "SECRET_MARKER", { mode: 0o600 })
  try {
    await run({
      directory,
      secret,
      encrypt,
      decrypt,
      options: {
        publicKeyFileForEncrypt: encryptPublic,
        privateKeyFileForDecrypt: decryptPrivate,
        keyDirectory: directory,
      },
    })
  } finally { await rm(directory, { recursive: true, force: true }) }
}

async function setup(
  options: Record<string, unknown>,
  prepare?: (registered: Map<string, Info>) => void,
) {
  const registered = new Map<string, Info>()
  let disposed = false
  let rpc: any
  const context = {
    options,
    tool: {
      transform: async (callback: (editor: ToolEditor) => void) => {
        callback({ add: (tool: Info) => registered.set(tool.name, tool) } as unknown as ToolEditor)
        return { dispose: async () => { disposed = true } }
      },
      list: async () => [...registered.values()],
    },
    rpc: {
      register: async (_definition: unknown, handlers: any) => {
        rpc = handlers
        return { dispose: async () => {} }
      },
    },
  } as unknown as Pick<Context, "options" | "tool" | "rpc">
  prepare?.(registered)
  const cleanup = await setupSensitiveEncrypt(context)
  return { registered, cleanup, disposed: () => disposed, rpc: () => rpc }
}

function fakeRegisterTool(calls: Array<Record<string, unknown>>) {
  return {
    id: "register_sensitive_file",
    name: "register_sensitive_file",
    description: "fake",
    input: { type: "object", properties: {}, required: [], additionalProperties: false },
    execute: async (input: unknown) => {
      calls.push(input as Record<string, unknown>)
      return { content: "ok", metadata: {} }
    },
  } as Info
}

function execute(tool: Info, input: Record<string, unknown>) {
  return tool.execute(input, {
    sessionID: "synthetic",
    agent: "synthetic",
    messageID: "synthetic",
    id: randomUUID(),
    progress: async () => {},
  } as unknown as ToolContext) as Promise<any>
}

test("registers encrypt, decrypt and key-info tools with concise descriptions", async () => {
  await fixture(async ({ options }) => {
    const { registered, cleanup, disposed } = await setup(options)
    try {
      expect(registered.get(TOOL_NAME)?.description).toBe(TOOL_DESCRIPTION)
      expect(registered.get(DECRYPT_TOOL_NAME)?.description).toBe(DECRYPT_TOOL_DESCRIPTION)
      expect(registered.get(KEY_INFO_TOOL_NAME)).toBeDefined()
      const decrypt = registered.get(DECRYPT_TOOL_NAME)!.input as any
      expect(decrypt.required).toEqual(["file", "out"])
      expect(decrypt.additionalProperties).toBe(false)
    } finally {
      await cleanup()
      expect(disposed()).toBe(true)
    }
  })
})

test("encrypts to a file and decrypts with an independent private key", async () => {
  await fixture(async ({ directory, secret, options, decrypt }) => {
    const { registered, cleanup } = await setup(options)
    try {
      const encrypted = await execute(registered.get(TOOL_NAME)!, {
        file: literal(directory, "secret.txt"),
      })
      expect(encrypted.content).toStartWith(ENVELOPE_PREFIX)
      expect(JSON.stringify(encrypted)).not.toContain("SECRET_MARKER")

      const encryptedFile = await execute(registered.get(TOOL_NAME)!, {
        file: literal(directory, "secret.txt"),
        out: literal(directory, "encrypt.ocsec"),
      })
      expect(encryptedFile.content).toContain("Encrypted to")
      expect(encryptedFile.content).not.toContain(ENVELOPE_PREFIX)
      expect(encryptedFile.metadata.input).toBe(await (await import("node:fs/promises")).realpath(secret))

      // Decryption uses an independent key pair, so create an envelope for the decrypt public key.
      const envelopeFile = path.join(directory, "decrypt.ocsec")
      await writeFile(envelopeFile, encryptEnvelope(parsePublicKey(decrypt.publicKey), Buffer.from("SECRET_MARKER")), { mode: 0o600 })
      const envelope = await readFile(envelopeFile, "utf8")

      const decrypted = await execute(registered.get(DECRYPT_TOOL_NAME)!, {
        file: literal(directory, "decrypt.ocsec"),
        out: literal(directory, "plain.txt"),
      })
      expect(decrypted.content).toContain("Decrypted to")
      expect(JSON.stringify(decrypted)).not.toContain("SECRET_MARKER")
      expect(decrypted.metadata.plaintextBytes).toBe(13)
      expect(await readFile(path.join(directory, "plain.txt"), "utf8")).toBe("SECRET_MARKER")
      expect((await stat(path.join(directory, "plain.txt"))).mode & 0o777).toBe(0o600)
      expect(decrypted.metadata.keyID).toMatch(/^[A-Za-z0-9_-]{43}$/)
    } finally { await cleanup() }
  })
})

test("does not decrypt with the encryption private key", async () => {
  await fixture(async ({ directory, options, encrypt }) => {
    const { registered, cleanup } = await setup(options)
    try {
      const envelope = encryptEnvelope(parsePublicKey(encrypt.publicKey), Buffer.from("SECRET_MARKER"))
      const file = path.join(directory, "wrong.ocsec")
      await writeFile(file, envelope, { mode: 0o600 })
      await expect(execute(registered.get(DECRYPT_TOOL_NAME)!, {
        file: literal(directory, "wrong.ocsec"),
        out: literal(directory, "wrong.txt"),
      })).rejects.toThrow("does not match")

      const encryptInfo = await execute(registered.get(KEY_INFO_TOOL_NAME)!, { role: "encrypt" })
      const decryptInfo = await execute(registered.get(KEY_INFO_TOOL_NAME)!, { role: "decrypt" })
      expect(encryptInfo.metadata.keys[0].keyID).not.toBe(decryptInfo.metadata.keys[0].keyID)
    } finally { await cleanup() }
  })
})

test("requires out, refuses overwriting the input, and reports key information", async () => {
  await fixture(async ({ directory, options, decrypt }) => {
    const { registered, cleanup } = await setup(options)
    try {
      const envelope = encryptEnvelope(parsePublicKey(decrypt.publicKey), Buffer.from("SECRET_MARKER"))
      const file = path.join(directory, "input.ocsec")
      await writeFile(file, envelope, { mode: 0o600 })
      await expect(execute(registered.get(DECRYPT_TOOL_NAME)!, { file: literal(directory, "input.ocsec") })).rejects.toThrow("out is required")
      await expect(execute(registered.get(DECRYPT_TOOL_NAME)!, {
        file: literal(directory, "input.ocsec"),
        out: literal(directory, "input.ocsec"),
      })).rejects.toThrow("must not overwrite")

      const info = await execute(registered.get(KEY_INFO_TOOL_NAME)!, { role: "all" })
      expect(info.content).toContain("encrypt public key")
      expect(info.content).toContain("decrypt public key")
      expect(JSON.stringify(info)).not.toContain("PRIVATE")
    } finally { await cleanup() }
  })
})

test("notifies an optional protection tool without forwarding its result", async () => {
  await fixture(async ({ directory, options }) => {
    const { registered, cleanup } = await setup(options)
    const calls: Array<Record<string, unknown>> = []
    try {
      registered.set("register_sensitive_file", {
        id: "register_sensitive_file",
        name: "register_sensitive_file",
        description: "fake",
        input: { type: "object", properties: {}, required: [], additionalProperties: false },
        execute: async (input: unknown) => {
          calls.push(input as Record<string, unknown>)
          return { content: "SECRET_MARKER", metadata: { secret: "SECRET_MARKER" } }
        },
      } as Info)
      const result = await execute(registered.get(TOOL_NAME)!, { file: literal(directory, "secret.txt") })
      expect(result.content).toStartWith(ENVELOPE_PREFIX)
      expect(calls).toHaveLength(1)
      expect(calls[0]?.role).toBe("encrypt-input")
      expect(calls[0]?.file).toBe(await import("../src/paths.js").then(({ resolveTempInput }) => resolveTempInput(literal(directory, "secret.txt"))))
    } finally { await cleanup() }
  })
})

test("exposes the TUI encryption RPC without exposing plaintext", async () => {
  await fixture(async ({ directory, options }) => {
    const { rpc, cleanup } = await setup(options)
    try {
      const result = await rpc().encrypt(
        { file: literal(directory, "secret.txt") },
        { error: () => { throw new Error("unexpected") } },
      )
      expect(result.ciphertext).toStartWith(ENVELOPE_PREFIX)
      expect(result.keyID).toMatch(/^[A-Za-z0-9_-]{43}$/)
      expect(JSON.stringify(result)).not.toContain("SECRET_MARKER")
    } finally { await cleanup() }
  })
})

test("notifies protection after decryption with the plaintext output path", async () => {
  await fixture(async ({ directory, options, decrypt }) => {
    const calls: Array<Record<string, unknown>> = []
    const { registered, cleanup } = await setup(options, (tools) => {
      tools.set("register_sensitive_file", fakeRegisterTool(calls))
    })
    try {
      const envelope = encryptEnvelope(parsePublicKey(decrypt.publicKey), Buffer.from("SECRET_MARKER"))
      await writeFile(path.join(directory, "incoming.ocsec"), envelope, { mode: 0o600 })
      await execute(registered.get(DECRYPT_TOOL_NAME)!, {
        file: literal(directory, "incoming.ocsec"),
        out: literal(directory, "plain.txt"),
      })
      expect(calls.map((call) => call.role)).toEqual(["manual", "decrypt-output"])
      expect(calls[1]?.file).toBe(await (await import("../src/paths.js")).resolveTempInput(literal(directory, "plain.txt")))
    } finally { await cleanup() }
  })
})

test("registers the configured decrypt private key for protection by default", async () => {
  await fixture(async ({ directory, options, decrypt }) => {
    const calls: Array<Record<string, unknown>> = []
    const { cleanup } = await setup(options, (registered) => {
      registered.set("register_sensitive_file", fakeRegisterTool(calls))
    })
    try {
      expect(calls).toHaveLength(1)
      expect(calls[0]?.role).toBe("manual")
      expect(calls[0]?.label).toBe("decrypt private key")
      expect(calls[0]?.file).toBe(path.resolve(directory, "decrypt-private.pem"))
      expect(calls[0]?.keyID).toMatch(/^[A-Za-z0-9_-]{43}$/)
      expect(JSON.stringify(calls)).not.toContain(decrypt.privateKey)
    } finally { await cleanup() }
  })
})

test("registers a generated default decrypt private key for protection", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "sensitive-encrypt-protect-"))
  const calls: Array<Record<string, unknown>> = []
  const { cleanup } = await setup(
    { encrypt: false, decrypt: true, keyDirectory: path.join(directory, "keys") },
    (registered) => { registered.set("register_sensitive_file", fakeRegisterTool(calls)) },
  )
  try {
    expect(calls).toHaveLength(1)
    expect(calls[0]?.role).toBe("manual")
    expect(calls[0]?.file).toBe(path.resolve(directory, "keys", "decrypt-private.pem"))
  } finally {
    await cleanup()
    await rm(directory, { recursive: true, force: true })
  }
})

test("retries private key protection on decryption when protection loads later", async () => {
  await fixture(async ({ directory, options, decrypt }) => {
    const { registered, cleanup } = await setup(options)
    const calls: Array<Record<string, unknown>> = []
    try {
      registered.set("register_sensitive_file", fakeRegisterTool(calls))
      const envelope = encryptEnvelope(parsePublicKey(decrypt.publicKey), Buffer.from("SECRET_MARKER"))
      await writeFile(path.join(directory, "incoming.ocsec"), envelope, { mode: 0o600 })
      await execute(registered.get(DECRYPT_TOOL_NAME)!, {
        file: literal(directory, "incoming.ocsec"),
        out: literal(directory, "plain.txt"),
      })
      expect(calls.map((call) => call.role)).toEqual(["manual", "decrypt-output"])
    } finally { await cleanup() }
  })
})

test("encrypt and decrypt can be disabled independently without generating keys", async () => {
  const { registered, cleanup } = await setup({ encrypt: false, decrypt: false })
  try {
    expect(registered.size).toBe(0)
  } finally { await cleanup() }
})
