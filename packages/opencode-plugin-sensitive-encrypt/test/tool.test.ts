import { expect, test } from "bun:test"
import type { Context } from "@opencode/plugin/promise/plugin"
import type { Info, ToolContext, ToolEditor } from "@opencode/plugin/promise/tool"
import { chmod, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { decryptEnvelope, ENVELOPE_PREFIX } from "../src/crypto.js"
import { setupSensitiveEncrypt, TOOL_DESCRIPTION, TOOL_NAME } from "../src/index.js"

function literal(directory: string, file = "") {
  return `$TMPDIR/${path.relative(os.tmpdir(), path.join(directory, file)).split(path.sep).join("/")}`
}

async function fixture(run: (value: {
  directory: string
  keyDirectory: string
  secret: string
  options: Record<string, unknown>
}) => Promise<void>) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "sensitive-encrypt-tool-"))
  const keyDirectory = path.join(directory, "keys")
  const secret = path.join(directory, "secret.txt")
  await writeFile(secret, "SECRET_MARKER", { mode: 0o600 })
  try {
    await run({ directory, keyDirectory, secret, options: { enabled: true, keyDirectory } })
  } finally { await rm(directory, { recursive: true, force: true }) }
}

async function setup(options: Record<string, unknown>) {
  let registered: Info | undefined
  let disposed = false
  const context = {
    options,
    tool: {
      transform: async (callback: (editor: ToolEditor) => void) => {
        callback({ add: (tool: Info) => { registered = tool } } as ToolEditor)
        return { dispose: async () => { disposed = true } }
      },
    },
  } as unknown as Pick<Context, "options" | "tool">
  const cleanup = await setupSensitiveEncrypt(context)
  return { registered, cleanup, disposed: () => disposed }
}

function execute(tool: Info, input: Record<string, unknown>) {
  return tool.execute(input, { sessionID: "synthetic", progress: async () => {} } as unknown as ToolContext) as Promise<any>
}

test("registers the exact tool shape and encrypts a temp file without exposing its contents", async () => {
  await fixture(async ({ directory, keyDirectory, secret, options }) => {
    const { registered, cleanup, disposed } = await setup(options)
    try {
      expect(registered?.name).toBe(TOOL_NAME)
      expect(registered?.description).toBe(TOOL_DESCRIPTION)
      const schema = registered!.input as any
      expect(schema.required).toEqual(["file"])
      expect(schema.additionalProperties).toBe(false)
      expect(Object.keys(schema.properties).sort()).toEqual(["file", "out"])
      expect(schema.properties.file.description).toContain("$TMPDIR")
      expect(schema.properties.out.description).toContain("overwrites")

      const result = await execute(registered!, { file: literal(directory, "secret.txt") })
      expect(result.content).toStartWith(ENVELOPE_PREFIX)
      expect(JSON.stringify(result)).not.toContain("SECRET_MARKER")
      const privateKey = await readFile(path.join(keyDirectory, "private.pem"))
      expect(decryptEnvelope(result.content, privateKey).toString()).toBe("SECRET_MARKER")
      expect(result.metadata.keyID).toMatch(/^[A-Za-z0-9_-]{43}$/)
      expect(result.metadata.ciphertextBytes).toBe(Buffer.byteLength(result.content, "utf8"))
    } finally {
      await cleanup()
      expect(disposed()).toBe(true)
      expect(await readFile(secret, "utf8")).toBe("SECRET_MARKER")
    }
  })
})

test("writes ciphertext to out, overwrites regular files, and never returns plaintext", async () => {
  await fixture(async ({ directory, keyDirectory, options }) => {
    const out = path.join(directory, "secret.ocsec")
    await writeFile(out, "OLD", { mode: 0o644 })
    const { registered, cleanup } = await setup(options)
    try {
      const result = await execute(registered!, { file: literal(directory, "secret.txt"), out: literal(directory, "secret.ocsec") })
      expect(result.content).toContain("Encrypted to")
      expect(result.content).not.toContain(ENVELOPE_PREFIX)
      expect(JSON.stringify(result)).not.toContain("SECRET_MARKER")
      expect(result.metadata.out).toBe(await (async () => {
        const { resolveTempInput } = await import("../src/paths.js")
        return resolveTempInput(literal(directory, "secret.ocsec"))
      })())
      const ciphertext = await readFile(out, "utf8")
      expect(ciphertext).toStartWith(ENVELOPE_PREFIX)
      expect((await stat(out)).mode & 0o777).toBe(0o600)
      expect(decryptEnvelope(ciphertext, await readFile(path.join(keyDirectory, "private.pem"))).toString()).toBe("SECRET_MARKER")
    } finally { await cleanup() }
  })
})

test("rejects same-file output, symlink output, group-readable input, and files outside $TMPDIR", async () => {
  await fixture(async ({ directory, options }) => {
    const { registered, cleanup } = await setup(options)
    try {
      await expect(execute(registered!, { file: literal(directory, "secret.txt"), out: literal(directory, "secret.txt") })).rejects.toThrow("must not overwrite")
      const link = path.join(directory, "out-link")
      await symlink(path.join(directory, "secret.ocsec"), link)
      await expect(execute(registered!, { file: literal(directory, "secret.txt"), out: literal(directory, "out-link") })).rejects.toThrow("symbolic link")
      await chmod(path.join(directory, "secret.txt"), 0o644)
      if (process.platform !== "win32") await expect(execute(registered!, { file: literal(directory, "secret.txt") })).rejects.toThrow("group or others")
      await chmod(path.join(directory, "secret.txt"), 0o600)
      await expect(execute(registered!, { file: "/etc/hosts" })).rejects.toThrow("under $TMPDIR")
      await expect(execute(registered!, { file: literal(directory, "missing.txt") })).rejects.toThrow("not found")
    } finally { await cleanup() }
  })
})

test("enforces maxBytes and requires out for large inline ciphertext", async () => {
  await fixture(async ({ directory, keyDirectory, options }) => {
    const large = path.join(directory, "large.txt")
    await writeFile(large, "X".repeat(300_000), { mode: 0o600 })
    const { registered, cleanup } = await setup({ ...options, maxBytes: 300_000 })
    try {
      await expect(execute(registered!, { file: literal(directory, "large.txt") })).rejects.toThrow("specify out")
      const result = await execute(registered!, { file: literal(directory, "large.txt"), out: literal(directory, "large.ocsec") })
      expect(result.metadata.ciphertextBytes).toBeGreaterThan(300_000)
      expect(decryptEnvelope(await readFile(path.join(directory, "large.ocsec"), "utf8"), await readFile(path.join(keyDirectory, "private.pem"))).length).toBe(300_000)
    } finally { await cleanup() }
  })
})

test("a disabled plugin does not create keys or register a tool", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "sensitive-encrypt-disabled-"))
  try {
    const keyDirectory = path.join(directory, "keys")
    const { registered, cleanup } = await setup({ enabled: false, keyDirectory })
    try {
      expect(registered).toBeUndefined()
      await expect(stat(keyDirectory)).rejects.toThrow()
    } finally { await cleanup() }
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test("a missing public key with an existing private key warns and never reads the private key", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "sensitive-encrypt-collision-"))
  const privateFile = path.join(directory, "private.pem")
  const warnings: string[] = []
  const original = console.warn
  console.warn = (...args: unknown[]) => { warnings.push(args.join(" ")) }
  try {
    await writeFile(privateFile, "DO_NOT_READ", { mode: 0o600 })
    const { registered, cleanup } = await setup({ enabled: true, keyDirectory: directory })
    try {
      expect(registered).toBeUndefined()
      expect(warnings.join("\n")).toContain("private key exists")
      expect(await readFile(privateFile, "utf8")).toBe("DO_NOT_READ")
    } finally { await cleanup() }
  } finally {
    console.warn = original
    await rm(directory, { recursive: true, force: true })
  }
})

test("invalid explicit keys fail closed without generating a fallback pair", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "sensitive-encrypt-invalid-"))
  const warnings: string[] = []
  const original = console.warn
  console.warn = (...args: unknown[]) => { warnings.push(args.join(" ")) }
  try {
    for (const options of [
      { enabled: true, publicKey: "NOT_A_KEY", keyDirectory: path.join(directory, "a") },
      { enabled: true, publicKeyFile: path.join(directory, "missing.pem"), keyDirectory: path.join(directory, "b") },
    ]) {
      const { registered, cleanup } = await setup(options)
      try { expect(registered).toBeUndefined() } finally { await cleanup() }
      await expect(stat(options.keyDirectory)).rejects.toThrow()
    }
    expect(warnings.length).toBeGreaterThanOrEqual(2)
  } finally {
    console.warn = original
    await rm(directory, { recursive: true, force: true })
  }
})
