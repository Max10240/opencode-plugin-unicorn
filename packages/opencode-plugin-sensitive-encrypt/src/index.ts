import { Plugin } from "@opencode/plugin"
import type { Context } from "@opencode/plugin/promise/plugin"
import type { ToolContext } from "@opencode/plugin/promise/tool"
import { decryptEnvelope, encryptEnvelope, ENVELOPE_ALGORITHM, type ParsedPublicKey } from "./crypto.js"
import { MAX_INLINE_CIPHERTEXT_BYTES, parseOptions, type ResolvedSensitiveEncryptOptions } from "./options.js"
import {
  ensureDecryptKey,
  ensureEncryptPublicKey,
  existingDecryptPrivateKeyFiles,
  readCiphertextFile,
  readDecryptKey,
  readSecretFile,
  writeCiphertext,
  writePlaintext,
  type DecryptKey,
} from "./paths.js"
import { EncryptPreview } from "./rpc.js"

export const TOOL_NAME = "encrypt_sensitive"
export const DECRYPT_TOOL_NAME = "decrypt_sensitive"
export const KEY_INFO_TOOL_NAME = "sensitive_key_info"

export const TOOL_DESCRIPTION = `Encrypt a single file under $TMPDIR with the configured public key only when the user explicitly requests it. Create it with \`mktemp\` and a shell redirect or pipe; never use the write/read tools, cat, or any other method that puts its contents in context. If \`out\` is used, keep it under $TMPDIR. Example: \`tmp=$(mktemp "\${TMPDIR:-/tmp}/secret.XXXXXX") && printf '%s' "$SECRET" > "$tmp" && echo "$tmp"\`, then call \`{"file":"<printed path>","out":"$TMPDIR/secret.ocsec"}\`.`

export const DECRYPT_TOOL_DESCRIPTION = `Decrypt a single ocsec1 file under $TMPDIR into a new file with the configured private key only when the user explicitly requests it. Never output plaintext or key material; always write the result to out and report only its path. Keep out under $TMPDIR.`

export const KEY_INFO_DESCRIPTION = "Show the configured public key and fingerprint without exposing private key material."

type PluginContext = Pick<Context, "options" | "tool"> & Partial<Pick<Context, "rpc">>
type RegisterInput = {
  readonly file: string
  readonly role: "encrypt-input" | "decrypt-output" | "manual"
  readonly keyID?: string
  readonly label?: string
  readonly sessionID?: string
  readonly toolCallID?: string
}

function warn(role: string, error: unknown) {
  const message = error instanceof Error ? error.message : "unknown error"
  console.warn(`Sensitive ${role} disabled: ${message}`)
}

async function notifyProtection(context: PluginContext, tool: ToolContext, input: RegisterInput) {
  try {
    const register = (await context.tool.list()).find((entry) => entry.id === "register_sensitive_file" || entry.name === "register_sensitive_file")
    if (!register) return false
    await register.execute(input, tool)
    return true
  } catch {
    // Protection is optional; registration failures must not affect encryption or decryption.
    return false
  }
}

async function protectDecryptPrivateKeys(
  context: PluginContext,
  options: ResolvedSensitiveEncryptOptions,
  decryptKey: DecryptKey | undefined,
  tool: ToolContext,
) {
  const files = await existingDecryptPrivateKeyFiles(options)
  if (files.length === 0) return true
  let registered = true
  for (const file of files) {
    const ok = await notifyProtection(context, tool, {
      file,
      role: "manual",
      label: "decrypt private key",
      ...(decryptKey !== undefined && file === decryptKey.path ? { keyID: decryptKey.keyID } : {}),
      sessionID: tool.sessionID,
      toolCallID: tool.id,
    })
    if (!ok) registered = false
  }
  return registered
}

function syntheticToolContext(): ToolContext {
  return {
    sessionID: "" as ToolContext["sessionID"],
    agent: "" as ToolContext["agent"],
    messageID: "" as ToolContext["messageID"],
    id: "" as ToolContext["id"],
    progress: async () => {},
    signal: new AbortController().signal,
  } as unknown as ToolContext
}

function decryptEnvelopeLimit(maxBytes: number) {
  return Math.min(maxBytes * 2 + 4096, 64 * 1024 * 1024 * 2 + 4096)
}

async function encryptFile(
  options: ResolvedSensitiveEncryptOptions,
  publicKey: ParsedPublicKey,
  input: { readonly file?: unknown; readonly out?: unknown },
) {
  if (typeof input.file !== "string" || !input.file.trim()) throw new Error("file is required")
  if (input.out !== undefined && (typeof input.out !== "string" || !input.out.trim())) {
    throw new Error("out must be a non-empty path")
  }
  const source = await readSecretFile(input.file, options.maxBytes)
  const envelope = encryptEnvelope(publicKey, source.data)
  const metadata = {
    algorithm: ENVELOPE_ALGORITHM,
    keyID: publicKey.kid,
    input: source.path,
    ciphertextBytes: Buffer.byteLength(envelope, "utf8"),
  }
  if (input.out === undefined) {
    if (metadata.ciphertextBytes > MAX_INLINE_CIPHERTEXT_BYTES) {
      throw new Error("Ciphertext is too large for inline output; specify out")
    }
    return {
      content: envelope,
      metadata,
      ciphertext: envelope,
      input: source.path,
    }
  }
  const out = await writeCiphertext(input.out, envelope, source.path)
  return {
    content: `Encrypted to ${out} (key ${publicKey.kid}).`,
    metadata: { ...metadata, out },
    ciphertext: metadata.ciphertextBytes <= MAX_INLINE_CIPHERTEXT_BYTES ? envelope : undefined,
    input: source.path,
    out,
  }
}

function createEncryptTool(context: PluginContext, options: ResolvedSensitiveEncryptOptions, publicKey: ParsedPublicKey) {
  return {
    name: TOOL_NAME,
    options: { codemode: false as const },
    description: TOOL_DESCRIPTION,
    input: {
      type: "object",
      properties: {
        file: { type: "string", description: "Secret file under $TMPDIR; use $TMPDIR/path." },
        out: { type: "string", description: "Optional ciphertext path under $TMPDIR; overwrites a regular file atomically." },
      },
      required: ["file"],
      additionalProperties: false,
    },
    execute: async (rawInput: unknown, tool: ToolContext) => {
      const result = await encryptFile(options, publicKey, rawInput as { file?: unknown; out?: unknown })
      await notifyProtection(context, tool, {
        file: result.input,
        role: "encrypt-input",
        keyID: publicKey.kid,
        sessionID: tool.sessionID,
        toolCallID: tool.id,
      })
      return { content: result.content, metadata: result.metadata }
    },
  }
}

function createDecryptTool(
  context: PluginContext,
  options: ResolvedSensitiveEncryptOptions,
  key: DecryptKey,
  ensurePrivateKeyProtection: (tool: ToolContext) => Promise<boolean>,
) {
  return {
    name: DECRYPT_TOOL_NAME,
    options: { codemode: false as const },
    description: DECRYPT_TOOL_DESCRIPTION,
    input: {
      type: "object",
      properties: {
        file: { type: "string", description: "ocsec1 ciphertext file under $TMPDIR." },
        out: { type: "string", description: "Required plaintext output path under $TMPDIR; written with mode 0600." },
      },
      required: ["file", "out"],
      additionalProperties: false,
    },
    execute: async (rawInput: unknown, tool: ToolContext) => {
      const input = rawInput as { readonly file?: unknown; readonly out?: unknown }
      if (typeof input.file !== "string" || !input.file.trim()) throw new Error("file is required")
      if (typeof input.out !== "string" || !input.out.trim()) throw new Error("out is required")
      const source = await readCiphertextFile(input.file, decryptEnvelopeLimit(options.maxBytes))
      const envelope = source.data.toString("utf8").trim()
      const current = await readDecryptKey(key.path)
      const plaintext = decryptEnvelope(envelope, current.privateKey)
      if (plaintext.length > options.maxBytes) {
        throw new Error(`decrypted file exceeds the ${options.maxBytes} byte limit`)
      }
      const out = await writePlaintext(input.out, plaintext, source.path)
      await ensurePrivateKeyProtection(tool)
      const metadata = {
        algorithm: ENVELOPE_ALGORITHM,
        keyID: current.keyID,
        input: source.path,
        out,
        plaintextBytes: plaintext.length,
      }
      await notifyProtection(context, tool, {
        file: out,
        role: "decrypt-output",
        keyID: current.keyID,
        sessionID: tool.sessionID,
        toolCallID: tool.id,
      })
      return {
        content: `Decrypted to ${out} (key ${current.keyID}, bytes ${plaintext.length}).`,
        metadata,
      }
    },
  }
}

function createKeyInfoTool(publicKey: ParsedPublicKey | undefined, decryptKey: DecryptKey | undefined) {
  return {
    name: KEY_INFO_TOOL_NAME,
    options: { codemode: false as const },
    description: KEY_INFO_DESCRIPTION,
    input: {
      type: "object",
      properties: {
        role: { type: "string", enum: ["encrypt", "decrypt", "all"] },
      },
      required: [],
      additionalProperties: false,
    },
    execute: async (rawInput: unknown) => {
      const input = rawInput as { readonly role?: unknown }
      const role = input.role === "encrypt" || input.role === "decrypt" ? input.role : "all"
      const keys: Array<{ role: string; keyID: string; publicKey: string }> = []
      if ((role === "encrypt" || role === "all") && publicKey) {
        keys.push({
          role: "encrypt",
          keyID: publicKey.kid,
          publicKey: publicKey.key.export({ type: "spki", format: "pem" }).toString(),
        })
      }
      if ((role === "decrypt" || role === "all") && decryptKey?.publicKey) {
        keys.push({
          role: "decrypt",
          keyID: decryptKey.keyID,
          publicKey: decryptKey.publicKey,
        })
      }
      if (keys.length === 0) throw new Error(`No ${role} public key is available`)
      return {
        content: keys.map((item) => `${item.role} public key (${item.keyID}):\n${item.publicKey}`).join("\n\n"),
        metadata: { keys },
      }
    },
  }
}

export async function setupSensitiveEncrypt(context: PluginContext) {
  let options: ResolvedSensitiveEncryptOptions
  try {
    options = parseOptions(context.options)
  } catch (error) {
    warn("encryption", error)
    return async () => {}
  }
  if (!options.enabled) return async () => {}

  let publicKey: ParsedPublicKey | undefined
  if (options.encrypt) {
    try {
      publicKey = await ensureEncryptPublicKey(options)
    } catch (error) {
      warn("encryption", error)
    }
  }

  let decryptKey: DecryptKey | undefined
  if (options.decrypt) {
    try {
      decryptKey = await ensureDecryptKey(options)
    } catch (error) {
      warn("decryption", error)
    }
  }

  let privateKeyProtection: Promise<boolean> | undefined
  const ensurePrivateKeyProtection = (tool: ToolContext) => {
    if (privateKeyProtection) return privateKeyProtection
    privateKeyProtection = protectDecryptPrivateKeys(context, options, decryptKey, tool).then((ok) => {
      if (!ok) privateKeyProtection = undefined
      return ok
    })
    return privateKeyProtection
  }
  await ensurePrivateKeyProtection(syntheticToolContext())

  if (!publicKey && !decryptKey) return async () => {}

  const cleanups: Array<() => Promise<void> | void> = []
  try {
    const registration = await context.tool.transform((editor) => {
      if (publicKey) editor.add(createEncryptTool(context, options, publicKey) as never)
      if (decryptKey) editor.add(createDecryptTool(context, options, decryptKey, ensurePrivateKeyProtection) as never)
      editor.add(createKeyInfoTool(publicKey, decryptKey) as never)
    })
    cleanups.push(() => registration.dispose())

    if (context.rpc && publicKey) {
      const rpc = await context.rpc.register(EncryptPreview, {
        encrypt: async (rawInput, request) => {
          const input = rawInput as { readonly file?: unknown; readonly out?: unknown }
          try {
            const result = await encryptFile(options, publicKey, input)
            await notifyProtection(context, syntheticToolContext(), {
              file: result.input,
              role: "encrypt-input",
              keyID: publicKey.kid,
            })
            return {
              ...(result.ciphertext === undefined ? {} : { ciphertext: result.ciphertext }),
              ...(result.out === undefined ? {} : { out: result.out }),
              keyID: publicKey.kid,
              bytes: result.metadata.ciphertextBytes,
            }
          } catch {
            return request.error("unavailable", "Unable to encrypt this file", {})
          }
        },
      })
      cleanups.push(() => rpc.dispose())
    }
  } catch (error) {
    await Promise.allSettled(cleanups.map((cleanup) => cleanup()))
    warn("encryption", error)
    return async () => {}
  }

  return async () => {
    await Promise.allSettled(cleanups.map((cleanup) => cleanup()))
  }
}

export default Plugin.define({
  id: "max10240.sensitive-encrypt",
  setup: setupSensitiveEncrypt,
})
