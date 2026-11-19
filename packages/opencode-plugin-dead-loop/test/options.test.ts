import { describe, expect, test } from "bun:test"
import { DAY_MS, MINUTE_MS } from "../src/duration.js"
import { deadLoopEnabled, DEFAULT_MESSAGE, parseDeadLoopOptions } from "../src/options.js"

describe("deadLoopEnabled", () => {
  test("is enabled by default", () => {
    expect(deadLoopEnabled({})).toBe(true)
    expect(deadLoopEnabled({ features: {} })).toBe(true)
  })

  test("features.deadLoop false disables", () => {
    expect(deadLoopEnabled({ features: { deadLoop: false } })).toBe(false)
    expect(deadLoopEnabled({ features: { promptSearch: false } })).toBe(true)
  })

  test("enabled false disables regardless of features", () => {
    expect(deadLoopEnabled({ enabled: false })).toBe(false)
    expect(deadLoopEnabled({ enabled: false, features: { deadLoop: true } })).toBe(false)
  })
})

describe("parseDeadLoopOptions", () => {
  test("applies defaults", () => {
    const options = parseDeadLoopOptions({})
    expect(options.message).toBe(DEFAULT_MESSAGE)
    expect(options.delayMs).toBe(3_000)
    expect(options.recheckMs).toBe(15_000)
    expect(options.minDurationMs).toBe(5 * MINUTE_MS)
    expect(options.maxDurationMs).toBe(7 * DAY_MS)
    expect(options.defaultDurationMs).toBe(60 * MINUTE_MS)
    expect(options.presets).toEqual(["15m", "1h", "2h", "3h", "8h", "1d"])
    expect(options.keybind).toBe("ctrl+shift+l")
    expect(options.enabled).toBe(true)
  })

  test("accepts overrides", () => {
    const options = parseDeadLoopOptions({
      message: "Keep going.",
      delayMs: 500,
      recheckMs: 2_000,
      minDurationMs: 1_000,
      maxDurationMs: 60_000,
      defaultDurationMs: 30_000,
      presets: ["10m", "5h"],
      keybind: "ctrl+shift+k",
      features: { deadLoop: true },
    })
    expect(options).toMatchObject({
      message: "Keep going.",
      delayMs: 500,
      recheckMs: 2_000,
      minDurationMs: 1_000,
      maxDurationMs: 60_000,
      defaultDurationMs: 30_000,
      presets: ["10m", "5h"],
      keybind: "ctrl+shift+k",
      enabled: true,
    })
  })

  test("keybind false disables the binding", () => {
    expect(parseDeadLoopOptions({ keybind: false }).keybind).toBe(false)
  })

  test("rejects invalid values", () => {
    expect(() => parseDeadLoopOptions({ message: "" })).toThrow("message")
    expect(() => parseDeadLoopOptions({ delayMs: 0 })).toThrow("delayMs")
    expect(() => parseDeadLoopOptions({ delayMs: 1_000.5 })).toThrow("delayMs")
    expect(() => parseDeadLoopOptions({ recheckMs: 10 })).toThrow("recheckMs")
    expect(() => parseDeadLoopOptions({ minDurationMs: 100 })).toThrow("minDurationMs")
    expect(() => parseDeadLoopOptions({ maxDurationMs: 31 * DAY_MS })).toThrow("maxDurationMs")
    expect(() => parseDeadLoopOptions({ minDurationMs: 60_000, maxDurationMs: 30_000 })).toThrow("maxDurationMs")
    expect(() => parseDeadLoopOptions({ defaultDurationMs: 20_000, minDurationMs: 30_000 })).toThrow("defaultDurationMs")
    expect(() => parseDeadLoopOptions({ presets: ["nope"] })).toThrow("presets")
    expect(() => parseDeadLoopOptions({ presets: "15m" })).toThrow("presets")
    expect(() => parseDeadLoopOptions({ presets: ["15m", "15M"] })).toThrow("duplicate")
    expect(() => parseDeadLoopOptions({ keybind: "  " })).toThrow("keybind")
  })
})
