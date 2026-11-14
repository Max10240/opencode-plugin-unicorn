import { expect, test } from "bun:test"
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { ProtectionRegistry, REDACTION_TOKEN } from "../src/registry.js"

test("manual private key registration protects body lines without marker patterns", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sensitive-registry-"))
  try {
    const file = path.join(root, "decrypt-private.pem")
    const data = path.join(root, "data")
    await mkdir(data)
    const begin = ["-----BEGIN", "OPENSSH", "PRIVATE KEY-----"].join(" ")
    const end = ["-----END", "OPENSSH", "PRIVATE KEY-----"].join(" ")
    const body = "QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo="
    await writeFile(file, `${begin}\n${body}\n${end}\n`)

    const registry = new ProtectionRegistry(data, 1024 * 1024)
    await registry.register(file, { role: "manual", label: "decrypt private key" })

    const [entry] = registry.list()
    expect(entry).toMatchObject({
      path: await realpath(file),
      label: "decrypt private key",
      source: "manual",
      keys: ["private key line"],
      keyCount: 1,
    })
    expect(registry.redact(begin)).toBe(begin)
    expect(registry.redact(end)).toBe(end)
    const redacted = registry.redact(body)
    expect(redacted).not.toContain(body)
    expect(redacted).toContain(REDACTION_TOKEN)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("manual generic files distinguish whole-file and line patterns", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sensitive-registry-"))
  try {
    const file = path.join(root, "secrets.txt")
    const data = path.join(root, "data")
    await mkdir(data)
    await writeFile(file, "GENERIC_SECRET_VALUE_123\nordinary configuration\n")
    const registry = new ProtectionRegistry(data, 1024 * 1024)
    await registry.register(file, { role: "manual", label: "generic secret" })

    const [entry] = registry.list()
    expect(entry?.keys).toEqual(expect.arrayContaining(["whole file", "line"]))
    expect(entry?.keys).not.toContain("GENERIC_SECRET_VALUE_123")
    expect(registry.redact("GENERIC_SECRET_VALUE_123")).toContain(REDACTION_TOKEN)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
