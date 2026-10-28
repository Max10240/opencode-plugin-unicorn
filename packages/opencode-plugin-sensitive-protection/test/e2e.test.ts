import { expect, setDefaultTimeout, test } from "bun:test"
import { generateKeyPairSync, randomUUID } from "node:crypto"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createOpenCodeE2E } from "../../opencode-plugin-unicorn/test/e2e-utils.js"
import { api, createSession, prompt, waitFor } from "../../opencode-plugin-show-img/test/e2e-utils.js"

setDefaultTimeout(180_000)

function literal(file: string) {
  return `$TMPDIR/${path.relative(os.tmpdir(), file).split(path.sep).join("/")}`
}

async function runTool(
  e2e: Awaited<ReturnType<typeof createOpenCodeE2E>>,
  message: string,
  tool: string,
  args: Record<string, unknown>,
) {
  const id = `call_${randomUUID()}`
  e2e.proxy.mock.prependFixture({
    match: { userMessage: message, toolName: tool, hasToolResult: false },
    response: { toolCalls: [{ id, name: tool, arguments: JSON.stringify(args) }] },
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

test("auto-registers encrypted input, blocks direct reads, and redacts shell output", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sensitive-protection-e2e-"))
  const secret = path.join(root, "secret.txt")
  const out = path.join(root, "secret.ocsec")
  const publicFile = path.join(root, "public.pem")
  const { publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 3072,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  })
  await writeFile(publicFile, publicKey)
  await writeFile(secret, "PROTECTION_E2E_SECRET_123", { mode: 0o600 })

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
        sensitiveProtection: true,
      },
      sensitiveEncrypt: { publicKeyFileForEncrypt: publicFile, decrypt: false },
      sensitiveProtection: { blockReads: true },
    },
  })
  try {
    await e2e.waitForModelContext(200_000)
    const encrypted = await runTool(e2e, "ENCRYPT_PROTECTED", "encrypt_sensitive", {
      file: literal(secret),
      out: literal(out),
    })
    expect(encrypted?.state.status).toBe("completed")
    expect(JSON.stringify(encrypted)).not.toContain("PROTECTION_E2E_SECRET_123")

    const registry = path.join(e2e.root, "xdg-data", "opencode", "sensitive-protection", "registry.json")
    await waitFor(async () => {
      const text = await readFile(registry, "utf8").catch(() => "")
      return text.includes(secret)
    }, "encrypted input was not registered")

    const blocked = await runTool(e2e, "READ_PROTECTED", "read", { path: secret })
    expect(blocked?.state.status).toBe("error")
    expect(JSON.stringify(blocked)).toContain("Blocked")
    expect(JSON.stringify(blocked)).not.toContain("PROTECTION_E2E_SECRET_123")

    const shell = await runTool(e2e, "SHELL_PROTECTED", "shell", {
      command: `cat '${secret.replaceAll("'", "'\\''")}'`,
    })
    expect(shell?.state.status).toBe("completed")
    expect(JSON.stringify(shell)).not.toContain("PROTECTION_E2E_SECRET_123")
    expect(JSON.stringify(shell)).toContain("[REDACTED:PROTECTED]")
    expect(JSON.stringify(e2e.proxy.requests)).not.toContain("PROTECTION_E2E_SECRET_123")
  } finally {
    await e2e.close()
    await rm(root, { recursive: true, force: true })
  }
})
