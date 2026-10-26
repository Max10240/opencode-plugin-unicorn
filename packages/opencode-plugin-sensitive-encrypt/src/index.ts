import { Plugin } from "@opencode/plugin"
import type { Context } from "@opencode/plugin/promise/plugin"
import { encryptEnvelope, ENVELOPE_ALGORITHM } from "./crypto.js"
import { MAX_INLINE_CIPHERTEXT_BYTES, parseOptions } from "./options.js"
import { ensurePublicKey, readSecretFile, writeCiphertext } from "./paths.js"

export const TOOL_NAME = "encrypt_sensitive"
export const TOOL_DESCRIPTION = `Encrypt a single file under $TMPDIR with the configured public key only when the user explicitly requests it. Create it with \`mktemp\` and a shell redirect or pipe; never use the write/read tools, cat, or any other method that puts its contents in context. If \`out\` is used, keep it under $TMPDIR. Example: \`tmp=$(mktemp "\${TMPDIR:-/tmp}/secret.XXXXXX") && printf '%s' "$SECRET" > "$tmp" && echo "$tmp"\`, then call \`{"file":"<printed path>","out":"$TMPDIR/secret.ocsec"}\`.`

function disable(error: unknown) {
  const message = error instanceof Error ? error.message : "unknown error"
  console.warn(`Sensitive encryption disabled: ${message}`)
}

export async function setupSensitiveEncrypt(context: Pick<Context, "options" | "tool">) {
  let options
  try {
    options = parseOptions(context.options)
  } catch (error) {
    disable(error)
    return async () => {}
  }
  if (!options.enabled) return async () => {}

  let publicKey
  try {
    publicKey = await ensurePublicKey(options)
  } catch (error) {
    disable(error)
    return async () => {}
  }

  try {
    const registration = await context.tool.transform((editor) => {
      editor.add({
        name: TOOL_NAME,
        options: { codemode: false },
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
        execute: async (rawInput) => {
          const input = rawInput as { readonly file?: unknown; readonly out?: unknown }
          if (typeof input.file !== "string" || !input.file.trim()) throw new Error("file is required")
          if (input.out !== undefined && (typeof input.out !== "string" || !input.out.trim())) {
            throw new Error("out must be a non-empty path")
          }
          const source = await readSecretFile(input.file, options.maxBytes)
          const envelope = encryptEnvelope(publicKey, source.data)
          const metadata = {
            algorithm: ENVELOPE_ALGORITHM,
            keyID: publicKey.kid,
            ciphertextBytes: Buffer.byteLength(envelope, "utf8"),
          }
          if (input.out === undefined) {
            if (metadata.ciphertextBytes > MAX_INLINE_CIPHERTEXT_BYTES) {
              throw new Error("Ciphertext is too large for tool output; specify out")
            }
            return { content: envelope, metadata }
          }
          const out = await writeCiphertext(input.out, envelope, source.path)
          return {
            content: `Encrypted to ${out} (key ${publicKey.kid}).`,
            metadata: { ...metadata, out },
          }
        },
      })
    })
    return () => registration.dispose()
  } catch (error) {
    disable(error)
    return async () => {}
  }
}

export default Plugin.define({
  id: "max10240.sensitive-encrypt",
  setup: setupSensitiveEncrypt,
})
