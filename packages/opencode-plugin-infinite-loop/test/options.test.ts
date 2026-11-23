import { describe, expect, test } from "bun:test"
import { DAY_MS, MINUTE_MS } from "../src/duration.js"
import {
  DEFAULT_MESSAGE,
  DEFAULT_QUESTION_MESSAGE,
  infiniteLoopEnabled,
  MAX_COOLDOWN_MS,
  parseInfiniteLoopOptions,
} from "../src/options.js"

describe("infiniteLoopEnabled", () => {
  test("is enabled by default", () => {
    expect(infiniteLoopEnabled({})).toBe(true)
    expect(infiniteLoopEnabled({ features: {} })).toBe(true)
  })

  test("features.infiniteLoop false disables", () => {
    expect(infiniteLoopEnabled({ features: { infiniteLoop: false } })).toBe(false)
    expect(infiniteLoopEnabled({ features: { promptSearch: false } })).toBe(true)
  })

  test("enabled false disables regardless of features", () => {
    expect(infiniteLoopEnabled({ enabled: false })).toBe(false)
    expect(infiniteLoopEnabled({ enabled: false, features: { infiniteLoop: true } })).toBe(false)
  })
})

describe("parseInfiniteLoopOptions", () => {
  test("applies defaults", () => {
    const options = parseInfiniteLoopOptions({})
    expect(options.message).toBe(DEFAULT_MESSAGE)
    expect(options.delayMs).toBe(3_000)
    expect(options.recheckMs).toBe(2_000)
    expect(options.cooldownMs).toBe(5 * MINUTE_MS)
    expect(options.minDurationMs).toBe(5 * MINUTE_MS)
    expect(options.maxDurationMs).toBe(7 * DAY_MS)
    expect(options.defaultDurationMs).toBe(60 * MINUTE_MS)
    expect(options.presets).toEqual(["15m", "1h", "2h", "3h", "8h", "1d"])
    expect(options.keybind).toBe("ctrl+shift+i")
    expect(options.overviewKeybind).toBe("ctrl+shift+o")
    expect(options.blockQuestions).toBe(true)
    expect(options.questionMessage).toBe(DEFAULT_QUESTION_MESSAGE)
    expect(options.enabled).toBe(true)
  })

  test("accepts overrides", () => {
    const options = parseInfiniteLoopOptions({
      message: "Keep going.",
      delayMs: 500,
      recheckMs: 250,
      cooldownMs: 0,
      minDurationMs: 1_000,
      maxDurationMs: 8 * 3_600_000,
      defaultDurationMs: 30_000,
      presets: ["10m", "5h"],
      keybind: "ctrl+shift+k",
      overviewKeybind: false,
      blockQuestions: false,
      questionMessage: "Decide it yourself.",
      features: { infiniteLoop: true },
    })
    expect(options).toMatchObject({
      message: "Keep going.",
      delayMs: 500,
      recheckMs: 250,
      cooldownMs: 0,
      minDurationMs: 1_000,
      maxDurationMs: 8 * 3_600_000,
      defaultDurationMs: 30_000,
      presets: ["10m", "5h"],
      keybind: "ctrl+shift+k",
      overviewKeybind: false,
      blockQuestions: false,
      questionMessage: "Decide it yourself.",
      enabled: true,
    })
  })

  test("keybind false disables the binding", () => {
    expect(parseInfiniteLoopOptions({ keybind: false }).keybind).toBe(false)
    expect(parseInfiniteLoopOptions({ overviewKeybind: false }).overviewKeybind).toBe(false)
  })

  test("rejects invalid values", () => {
    expect(() => parseInfiniteLoopOptions({ message: "" })).toThrow("message")
    expect(() => parseInfiniteLoopOptions({ questionMessage: "" })).toThrow("questionMessage")
    expect(() => parseInfiniteLoopOptions({ blockQuestions: "yes" as unknown as boolean })).toThrow("blockQuestions")
    expect(() => parseInfiniteLoopOptions({ delayMs: 0 })).toThrow("delayMs")
    expect(() => parseInfiniteLoopOptions({ delayMs: 1_000.5 })).toThrow("delayMs")
    expect(() => parseInfiniteLoopOptions({ recheckMs: 10 })).toThrow("recheckMs")
    expect(() => parseInfiniteLoopOptions({ cooldownMs: -1 })).toThrow("cooldownMs")
    expect(() => parseInfiniteLoopOptions({ cooldownMs: 1.5 })).toThrow("cooldownMs")
    expect(() => parseInfiniteLoopOptions({ cooldownMs: MAX_COOLDOWN_MS + 1 })).toThrow("cooldownMs")
    expect(() => parseInfiniteLoopOptions({ minDurationMs: 100 })).toThrow("minDurationMs")
    expect(() => parseInfiniteLoopOptions({ maxDurationMs: 31 * DAY_MS })).toThrow("maxDurationMs")
    expect(() => parseInfiniteLoopOptions({ minDurationMs: 60_000, maxDurationMs: 30_000 })).toThrow("maxDurationMs")
    expect(() => parseInfiniteLoopOptions({ defaultDurationMs: 20_000, minDurationMs: 30_000 })).toThrow("defaultDurationMs")
    expect(() => parseInfiniteLoopOptions({ presets: ["nope"] })).toThrow("presets")
    expect(() => parseInfiniteLoopOptions({ presets: "15m" })).toThrow("presets")
    expect(() => parseInfiniteLoopOptions({ presets: ["15m", "15M"] })).toThrow("duplicate")
    expect(() => parseInfiniteLoopOptions({ keybind: "  " })).toThrow("keybind")
    expect(() => parseInfiniteLoopOptions({ overviewKeybind: "  " })).toThrow("overviewKeybind")
  })
})
