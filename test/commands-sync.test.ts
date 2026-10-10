import { expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { extractCommands, syncRecommendedCommands } from "../scripts/sync-recommended-commands.mjs"

test("extracts only inline commands and never copies provider credentials or other configuration", () => {
  const value = extractCommands(`{
    // JSONC comment
    "providers": {"openai":{"apiKey":"DO_NOT_EXPORT_THIS"}},
    "commands": {"review":{"template":"Review $ARGUMENTS","description":"Review","agent":"plan","model":"openai/model","subagent":false}},
    "command": {"legacy":{"template":"Do not copy"}},
  }`)
  expect(value).toEqual({ review: { template: "Review $ARGUMENTS", description: "Review", agent: "plan", model: "openai/model", subagent: false } })
  expect(JSON.stringify(value)).not.toContain("DO_NOT_EXPORT_THIS")
  expect(extractCommands('{"commands":{}}')).toEqual({})
})

test("invalid source data fails without exporting unrelated or malformed data", () => {
  for (const text of ["{broken", "[]", '{"commands":null}', '{"commands":[]}', '{"commands":{"invalid":{}}}', '{"commands":{"invalid":{"template":"text","description":false}}}', '{"commands":{"invalid":{"__proto__":{"template":"inherited"}}}}']) {
    expect(() => extractCommands(text)).toThrow()
  }
})

test("prototype-provided fields are not treated as inline command definitions", () => {
  expect(extractCommands('{"__proto__":{"commands":{"fake":{"template":"Do not copy"}}}}')).toEqual({})
})

test("refreshes the partial snapshot, removes source-deleted recommendations, and retains it when source is absent", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "opencode-command-snapshot-"))
  const source = path.join(root, "opencode.jsonc")
  const target = path.join(root, "commands.json")
  try {
    await writeFile(source, '{"commands":{"fixture":{"template":"Fixture"}},"private":"DO_NOT_EXPORT_THIS"}')
    expect(await syncRecommendedCommands({ source, target })).toBe(true)
    expect(JSON.parse(await readFile(target, "utf8"))).toEqual({ fixture: { template: "Fixture" } })
    expect(await syncRecommendedCommands({ source, target })).toBe(false)
    await writeFile(source, "{broken")
    await expect(syncRecommendedCommands({ source, target })).rejects.toThrow()
    expect(JSON.parse(await readFile(target, "utf8"))).toEqual({ fixture: { template: "Fixture" } })
    await writeFile(source, "{}")
    expect(await syncRecommendedCommands({ source, target })).toBe(true)
    expect(JSON.parse(await readFile(target, "utf8"))).toEqual({})
    await rm(source)
    expect(await syncRecommendedCommands({ source, target })).toBe(false)
  } finally { await rm(root, { recursive: true, force: true }) }
})
