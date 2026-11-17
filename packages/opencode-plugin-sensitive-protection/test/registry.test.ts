import { expect, test } from "bun:test"
import { randomUUID } from "node:crypto"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { ProtectionRegistry, REDACTION_TOKEN } from "../src/registry.js"
import { extractContent, patternsForValues } from "../src/spec.js"

test("registry redacts extracted values and reports key attribution", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sensitive-registry-"))
  try {
    const file = path.join(root, "settings.json")
    await writeFile(file, JSON.stringify({ apiKey: "ATTRIBUTION_SECRET_123" }))
    const registry = new ProtectionRegistry()
    const result = extractContent(JSON.stringify({ apiKey: "ATTRIBUTION_SECRET_123" }), "json", ["apiKey"], { strict: true })
    registry.set({
      path: file,
      source: "config",
      format: "json",
      keys: ["apiKey"],
      label: "settings",
      createdAt: Date.now(),
    }, patternsForValues(result.values))

    const collector = registry.createMatchCollector()
    const redacted = registry.redactWithCount("prefix ATTRIBUTION_SECRET_123 suffix", collector)
    expect(redacted.text).toBe(`prefix ${REDACTION_TOKEN} suffix`)
    expect(redacted.count).toBe(1)
    expect(registry.list()).toEqual([{
      path: file,
      source: "config",
      format: "json",
      keys: ["apiKey"],
      label: "settings",
      createdAt: expect.any(Number),
      keyCount: 1,
    }])
    expect(registry.matchList(collector)).toEqual([{
      file,
      source: "config",
      label: "settings",
      key: "apiKey",
      count: 1,
    }])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("registry removal drops patterns and emits changes", async () => {
  const registry = new ProtectionRegistry()
  const file = path.join(os.tmpdir(), `sensitive-${randomUUID()}.txt`)
  let changes = 0
  registry.onChange(() => changes++)
  registry.set({
    path: file,
    source: "manual",
    format: "line",
    keys: ["line"],
    createdAt: Date.now(),
  }, patternsForValues([{ value: "REMOVE_ME_123", key: "line" }]))
  expect(registry.redact("REMOVE_ME_123")).toBe(REDACTION_TOKEN)
  expect(registry.remove(file)).toBe(true)
  expect(registry.redact("REMOVE_ME_123")).toBe("REMOVE_ME_123")
  expect(changes).toBe(2)
})
