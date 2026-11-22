import { describe, expect, test } from "bun:test"
import {
  DEFAULT_CACHE_TTL_MS,
  DEFAULT_TIMEOUT_MS,
  GOD_AGENT_ID,
  parseGodOptions,
  selectPromptSource,
  selectPromptSources,
} from "../src/options.js"
import { DEFAULT_FALLBACK_PATH, DEFAULT_FAMILY_PATHS, DEFAULT_MODEL_PATHS, DEFAULT_SOURCE_BASE } from "../src/defaults.js"

describe("parseGodOptions", () => {
  test("uses defaults for missing options", () => {
    const options = parseGodOptions(undefined)
    expect(options.models.size).toBe(0)
    expect(options.cache).toBe(true)
    expect(options.cacheTtlMs).toBe(DEFAULT_CACHE_TTL_MS)
    expect(options.timeoutMs).toBe(DEFAULT_TIMEOUT_MS)
    expect(options.sourceBaseUrl).toBe(DEFAULT_SOURCE_BASE)
    expect(options.defaults.size).toBe(Object.keys(DEFAULT_MODEL_PATHS).length)
    expect(options.families.length).toBe(DEFAULT_FAMILY_PATHS.length)
    expect(options.fallback).toBe(`${DEFAULT_SOURCE_BASE}${DEFAULT_FALLBACK_PATH}`)
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

    expect(parseGodOptions({ models: "not an object" }).models.size).toBe(0)
    expect(parseGodOptions({ models: [] }).models.size).toBe(0)
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

    const unusable = parseGodOptions({ cacheTtlMs: Number.POSITIVE_INFINITY, timeoutMs: Number.NaN })
    expect(unusable.cacheTtlMs).toBe(DEFAULT_CACHE_TTL_MS)
    expect(unusable.timeoutMs).toBe(DEFAULT_TIMEOUT_MS)
  })

  test("normalizes the source base used by built-in entries", () => {
    const options = parseGodOptions({ sourceBaseUrl: " http://127.0.0.1:9/mirror " })
    expect(options.sourceBaseUrl).toBe("http://127.0.0.1:9/mirror/")
    expect(options.defaults.get("deepseek-v3")).toBe("http://127.0.0.1:9/mirror/DeepSeek/deepseek%20v3.md")
    expect(options.fallback).toBe(`http://127.0.0.1:9/mirror/${DEFAULT_FALLBACK_PATH}`)

    expect(parseGodOptions({ sourceBaseUrl: "http://127.0.0.1:9/mirror///" }).sourceBaseUrl).toBe("http://127.0.0.1:9/mirror/")
    expect(parseGodOptions({ sourceBaseUrl: "   " }).sourceBaseUrl).toBe(DEFAULT_SOURCE_BASE)
  })

  test("agent id is god", () => {
    expect(GOD_AGENT_ID).toBe("god")
  })

  test("ignores non-object options", () => {
    for (const value of [[], "text", 42, true]) {
      const options = parseGodOptions(value)
      expect(options.models.size).toBe(0)
      expect(options.defaults.size).toBe(Object.keys(DEFAULT_MODEL_PATHS).length)
    }
  })

  test("keeps the last value when keys differ only by whitespace", () => {
    const options = parseGodOptions({ models: { "model-a": "first.md", " model-a ": "second.md" } })
    expect([...options.models.entries()]).toEqual([["model-a", "second.md"]])
  })
})

describe("selectPromptSource", () => {
  const options = parseGodOptions({ sourceBaseUrl: "http://127.0.0.1:9/" })

  test("prefers a user entry over the built-in table", () => {
    const custom = parseGodOptions({ sourceBaseUrl: "http://127.0.0.1:9/", models: { "deepseek-v3": "mine.md" } })
    expect(selectPromptSource(custom, "deepseek-v3")).toBe("mine.md")
  })

  test("uses the built-in table for a known model id", () => {
    expect(selectPromptSource(options, "deepseek-v3")).toBe("http://127.0.0.1:9/DeepSeek/deepseek%20v3.md")
  })

  test("matches a user wildcard before the built-in table", () => {
    const wildcard = parseGodOptions({ sourceBaseUrl: "http://127.0.0.1:9/", models: { "*": "default.md" } })
    expect(selectPromptSource(wildcard, "deepseek-v3")).toBe("default.md")
    expect(selectPromptSource(wildcard, "unknown-model")).toBe("default.md")
  })

  test("matches a provider-qualified user key only for that provider", () => {
    const scoped = parseGodOptions({ sourceBaseUrl: "http://127.0.0.1:9/", models: { "openai/claude-sonnet-x": "scoped.md" } })
    expect(selectPromptSource(scoped, "claude-sonnet-x", "openai")).toBe("scoped.md")
    expect(selectPromptSource(scoped, "claude-sonnet-x", "anthropic")).not.toBe("scoped.md")
  })

  test("matches a built-in family prefix", () => {
    expect(selectPromptSource(options, "claude-opus-6-0")).toBe("http://127.0.0.1:9/Anthropic/opus%20v2.md")
    expect(selectPromptSource(options, "claude-sonnet-7-1")).toBe("http://127.0.0.1:9/Anthropic/Sonnet%20v2.md")
  })

  test("falls back to the built-in default for an unknown model id", () => {
    expect(selectPromptSource(options, "brand-new-model")).toBe(`http://127.0.0.1:9/${DEFAULT_FALLBACK_PATH}`)
  })

  test("reports the shared fallback for built-in matches only", () => {
    const custom = parseGodOptions({ sourceBaseUrl: "http://127.0.0.1:9/", models: { "deepseek-v3": "mine.md" } })
    expect(selectPromptSources(custom, "deepseek-v3").fallback).toBeUndefined()
    expect(selectPromptSources(options, "deepseek-v3").fallback).toBe(`http://127.0.0.1:9/${DEFAULT_FALLBACK_PATH}`)
    expect(selectPromptSources(options, "claude-opus-6-0").fallback).toBe(`http://127.0.0.1:9/${DEFAULT_FALLBACK_PATH}`)
    expect(selectPromptSources(options, "brand-new-model").fallback).toBeUndefined()
  })

  test("keeps the built-in entry when a scoped key names another provider", () => {
    const scoped = parseGodOptions({
      sourceBaseUrl: "http://127.0.0.1:9/",
      models: { "openai/deepseek-v3": "scoped.md" },
    })
    expect(selectPromptSource(scoped, "deepseek-v3", "anthropic")).toBe("http://127.0.0.1:9/DeepSeek/deepseek%20v3.md")
    expect(selectPromptSource(scoped, "deepseek-v3", "openai")).toBe("scoped.md")
  })

  test("treats model ids as case sensitive", () => {
    expect(selectPromptSource(options, "DeepSeek-V3")).toBe(`http://127.0.0.1:9/${DEFAULT_FALLBACK_PATH}`)
    expect(selectPromptSource(options, "")).toBe(`http://127.0.0.1:9/${DEFAULT_FALLBACK_PATH}`)
  })

  test("resolves free variants of a built-in model", () => {
    for (const id of ["deepseek-v4.1-flash-free", "deepseek-v4.1-flash:free"]) {
      expect(selectPromptSources(options, id)).toEqual({
        source: "http://127.0.0.1:9/DeepSeek/deepseekv4.1%20and%20v4.1-1017.md",
        fallback: `http://127.0.0.1:9/${DEFAULT_FALLBACK_PATH}`,
      })
    }
    expect(selectPromptSource(options, "space-bunny-free")).toBe("http://127.0.0.1:9/Stealth%20Models/spacebunny-agents.md")
    expect(selectPromptSource(options, "longcat-2.5-free")).toBe("http://127.0.0.1:9/Meituan/longcat-agents.md")
  })
})
