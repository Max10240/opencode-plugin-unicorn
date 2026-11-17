import { describe, expect, test } from "bun:test"
import {
  DEFAULT_CACHE_TTL_MS,
  DEFAULT_TIMEOUT_MS,
  GOD_AGENT_ID,
  parseGodOptions,
  selectPromptSource,
} from "../src/options.js"

describe("parseGodOptions", () => {
  test("uses defaults for missing options", () => {
    const options = parseGodOptions(undefined)
    expect(options.models.size).toBe(0)
    expect(options.cache).toBe(true)
    expect(options.cacheTtlMs).toBe(DEFAULT_CACHE_TTL_MS)
    expect(options.timeoutMs).toBe(DEFAULT_TIMEOUT_MS)
  })

  test("reads model mappings and trims keys and values", () => {
    const options = parseGodOptions({
      models: {
        " deepseek-v4.1-flash ": " prompts/deepseek.md ",
        "*": " prompts/default.md ",
      },
    })
    expect(options.models.get("deepseek-v4.1-flash")).toBe("prompts/deepseek.md")
    expect(options.models.get("*")).toBe("prompts/default.md")
  })

  test("ignores invalid model mappings", () => {
    const options = parseGodOptions({
      models: {
        "": "prompt.md",
        empty: " ",
        number: 42,
        valid: "prompt.md",
      },
    })
    expect([...options.models.entries()]).toEqual([["valid", "prompt.md"]])
  })

  test("validates cache and timeout options", () => {
    const options = parseGodOptions({ cache: false, cacheTtlMs: 2500, timeoutMs: 500 })
    expect(options.cache).toBe(false)
    expect(options.cacheTtlMs).toBe(2500)
    expect(options.timeoutMs).toBe(500)

    const invalid = parseGodOptions({ cache: "no", cacheTtlMs: -1, timeoutMs: 0 })
    expect(invalid.cache).toBe(true)
    expect(invalid.cacheTtlMs).toBe(DEFAULT_CACHE_TTL_MS)
    expect(invalid.timeoutMs).toBe(DEFAULT_TIMEOUT_MS)
  })

  test("agent id is god", () => {
    expect(GOD_AGENT_ID).toBe("god")
  })
})

describe("selectPromptSource", () => {
  const options = parseGodOptions({
    models: {
      "claude-sonnet": "sonnet.md",
      "openai/claude-sonnet": "prefixed.md",
      "*": "default.md",
    },
  })

  test("matches the exact model id", () => {
    expect(selectPromptSource(options, "claude-sonnet")).toBe("sonnet.md")
  })

  test("falls back to the wildcard entry", () => {
    expect(selectPromptSource(options, "unknown-model")).toBe("default.md")
  })

  test("does not include the provider in the key", () => {
    expect(selectPromptSource(options, "claude-sonnet")).not.toBe("prefixed.md")
    expect(selectPromptSource(options, "openai/claude-sonnet")).toBe("prefixed.md")
  })

  test("returns undefined without an exact or wildcard entry", () => {
    const exactOnly = parseGodOptions({ models: { "claude-sonnet": "sonnet.md" } })
    expect(selectPromptSource(exactOnly, "other-model")).toBeUndefined()
  })
})
