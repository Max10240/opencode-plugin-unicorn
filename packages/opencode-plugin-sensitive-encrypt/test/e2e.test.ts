import { expect, setDefaultTimeout, test } from "bun:test"
import { randomUUID } from "node:crypto"
import { access, chmod, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createOpenCodeE2E } from "../../opencode-plugin-unicorn/test/e2e-utils.js"
import { api, createSession, prompt, waitFor } from "../../opencode-plugin-show-img/test/e2e-utils.js"
import { decryptEnvelope } from "../src/crypto.js"

setDefaultTimeout(180_000)

function literal(file: string) {
  return `$TMPDIR/${path.relative(os.tmpdir(), file).split(path.sep).join("/")}`
}

test("encrypts temp files in real OpenCode and keeps working after the private key is moved away", async () => {
  const secretRoot = await mkdtemp(path.join(os.tmpdir(), "sensitive-encrypt-e2e-"))
  const movedRoot = await mkdtemp(path.join(os.tmpdir(), "sensitive-encrypt-private-"))
  const secretOne = path.join(secretRoot, "secret-one.txt")
  const secretTwo = path.join(secretRoot, "secret-two.txt")
  const firstOut = path.join(secretRoot, "secret-one.ocsec")
  const secondOut = path.join(secretRoot, "secret-two.ocsec")
  const movedPrivate = path.join(movedRoot, "private.pem")
  await writeFile(secretOne, "SECRET_ONE_MARKER", { mode: 0o600 })
  await writeFile(secretTwo, "SECRET_TWO_MARKER", { mode: 0o600 })

  const e2e = await createOpenCodeE2E({
    plugin: "sensitive-encrypt",
    pluginPackage: path.resolve(import.meta.dir, "../dist"),
    pluginOptions: { enabled: true },
  })
  const keyDirectory = path.join(e2e.configDirectory, "sensitive-encrypt")
  const publicKey = path.join(keyDirectory, "public.pem")
  const privateKey = path.join(keyDirectory, "private.pem")
  try {
    await e2e.waitForModelContext(200_000)
    await waitFor(async () => {
      await access(publicKey)
      await access(privateKey)
      return true
    }, "Default key pair was not initialized")
    if (process.platform !== "win32") {
      expect((await stat(privateKey)).mode & 0o777).toBe(0o600)
      expect((await stat(publicKey)).mode & 0o777).toBe(0o644)
    }

    const call = async (message: string, file: string, out: string) => {
      const id = `call_${randomUUID()}`
      e2e.proxy.mock.prependFixture({
        match: { userMessage: message, toolName: "encrypt_sensitive", hasToolResult: false },
        response: { toolCalls: [{ id, name: "encrypt_sensitive", arguments: JSON.stringify({ file: literal(file), out: literal(out) }) }] },
      })
      e2e.proxy.mock.prependFixture({ match: { toolCallId: id }, response: { content: "ENCRYPT_DONE" } })
      const sessionID = await createSession(e2e)
      await prompt(e2e, sessionID, message)
      const exported = await api<{ data: { messages: Array<Record<string, any>> } }>(e2e, `/api/experimental/session/${sessionID}/export`)
      const part = exported.data.messages.flatMap((entry) => entry.content ?? []).find((entry) => entry.type === "tool" && entry.id === id)
      expect(part?.state.status).toBe("completed")
      expect(JSON.stringify(part)).not.toContain("SECRET_")
      return part
    }

    await call("ENCRYPT_FIRST", secretOne, firstOut)
    const first = await readFile(firstOut, "utf8")
    expect(first).toStartWith("ocsec1:")
    expect(decryptEnvelope(first, await readFile(privateKey)).toString()).toBe("SECRET_ONE_MARKER")
    expect(JSON.stringify(e2e.proxy.requests)).not.toContain("SECRET_ONE_MARKER")

    await rename(privateKey, movedPrivate)
    await expect(access(privateKey)).rejects.toThrow()
    await e2e.restart()
    await e2e.waitForModelContext(200_000)
    await expect(access(privateKey)).rejects.toThrow()

    await call("ENCRYPT_SECOND", secretTwo, secondOut)
    const second = await readFile(secondOut, "utf8")
    expect(decryptEnvelope(second, await readFile(movedPrivate)).toString()).toBe("SECRET_TWO_MARKER")
    expect(JSON.stringify(e2e.proxy.requests)).not.toContain("SECRET_TWO_MARKER")
    expect(JSON.stringify(e2e.proxy.requests)).not.toContain("SECRET_ONE_MARKER")
  } finally {
    await e2e.close()
    await chmod(secretRoot, 0o700).catch(() => {})
    await rm(secretRoot, { recursive: true, force: true })
    await rm(movedRoot, { recursive: true, force: true })
  }
})
