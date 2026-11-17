import { expect, test } from "bun:test"
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { ProtectionHistory } from "../src/history.js"
import { ProtectionRegistry } from "../src/registry.js"
import { parseProtectionOptions } from "../src/options.js"
import { extractContent, patternsForValues } from "../src/spec.js"

test("aggregates repeated conditions without growing the history", () => {
  const history = new ProtectionHistory(10)
  const input = {
    kind: "redacted" as const,
    source: "context" as const,
    count: 8,
    sessionID: "ses_test",
    matches: [{ file: "/home/user/.npmrc", label: "npm auth", source: "default" as const, key: "_authToken", count: 8 }],
  }
  const first = history.record(input)
  const second = history.record(input)
  expect(second.id).toBe(first.id)
  expect(second.occurrences).toBe(2)
  expect(second.firstTime).toBe(first.firstTime)
  expect(history.size).toBe(1)

  const more = history.record({ ...input, count: 9 })
  expect(more.id).toBe(first.id)
  expect(more.occurrences).toBe(3)
  expect(more.count).toBe(9)
  expect(history.size).toBe(1)

  history.record({ ...input, file: "/home/user/.aws/credentials", matches: [
    { file: "/home/user/.aws/credentials", label: "AWS credentials", source: "default", key: "default.aws_secret_access_key", count: 1 },
  ], count: 1 })
  expect(history.size).toBe(2)
})

test("caps history, clears it, and never keeps secret values", () => {
  const history = new ProtectionHistory(2)
  history.record({ kind: "blocked", source: "read", count: 1, file: "/secret-a", matches: [{ file: "/secret-a", count: 1 }] })
  history.record({ kind: "blocked", source: "read", count: 1, file: "/secret-b", matches: [{ file: "/secret-b", count: 1 }] })
  history.record({ kind: "blocked", source: "read", count: 1, file: "/secret-c", matches: [{ file: "/secret-c", count: 1 }] })
  expect(history.size).toBe(2)
  expect(history.list().map((hit) => hit.file).sort()).toEqual(["/secret-b", "/secret-c"])
  expect(JSON.stringify(history.list())).not.toContain("SUPER_SECRET_VALUE")
  expect(history.clear()).toBe(2)
  expect(history.size).toBe(0)
})

test("sanitizes control characters and caps oversized metadata", () => {
  const history = new ProtectionHistory(1)
  const hit = history.record({
    kind: "error",
    source: "parser",
    count: 0,
    label: `bad\nfile\u0000${"x".repeat(300)}`,
    file: `/${"y".repeat(2_000)}`,
  })
  expect(hit.label).not.toContain("\n")
  expect(hit.label?.length).toBeLessThanOrEqual(200)
  expect(hit.file?.length).toBeLessThanOrEqual(1024)
})

test("a disabled history aggregates live events but keeps no entries", () => {
  const history = new ProtectionHistory(0)
  const first = history.record({ kind: "error", source: "parser", count: 0, label: "bad file" })
  const second = history.record({ kind: "error", source: "parser", count: 0, label: "bad file" })
  expect(second.id).toBe(first.id)
  expect(second.occurrences).toBe(2)
  expect(history.list()).toEqual([])
  expect(history.size).toBe(0)
})

test("history options default, validate, and allow disabling", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sensitive-options-"))
  try {
    const defaults = await parseProtectionOptions({}, root)
    expect(defaults.historyLimit).toBe(200)
    expect(defaults.historyKeybind).toBe("ctrl+shift+h")

    const custom = await parseProtectionOptions({ historyLimit: 0, historyKeybind: "ctrl+g" }, root)
    expect(custom.historyLimit).toBe(0)
    expect(custom.historyKeybind).toBe("ctrl+g")

    const disabled = await parseProtectionOptions({ historyKeybind: false }, root)
    expect(disabled.historyKeybind).toBe(false)

    await expect(parseProtectionOptions({ historyLimit: 1_001 }, root)).rejects.toThrow("historyLimit")
    await expect(parseProtectionOptions({ historyLimit: -1 }, root)).rejects.toThrow("historyLimit")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("registry attribution reports the matched file, key, and count only", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sensitive-attribution-"))
  const registry = new ProtectionRegistry()
  try {
    const file = path.join(root, "settings.json")
    await writeFile(file, JSON.stringify({ apiKey: "ATTRIBUTION_SECRET_123" }))
    const resolved = await realpath(file)
    const extracted = extractContent(JSON.stringify({ apiKey: "ATTRIBUTION_SECRET_123" }), "json", ["apiKey"], { strict: true })
    registry.set({
      path: resolved,
      format: "json",
      keys: ["apiKey"],
      label: "settings",
      source: "config",
      createdAt: Date.now(),
    }, patternsForValues(extracted.values))
    const collector = registry.createMatchCollector()
    const result = registry.redactValue({ text: "prefix ATTRIBUTION_SECRET_123 suffix" }, collector)
    expect(result.count).toBe(1)
    expect(JSON.stringify(result.value)).not.toContain("ATTRIBUTION_SECRET_123")
    expect(registry.matchList(collector)).toEqual([{
      file: resolved,
      label: "settings",
      source: "config",
      key: "apiKey",
      count: 1,
    }])
    expect(JSON.stringify(registry.matchList(collector))).not.toContain("ATTRIBUTION_SECRET_123")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
