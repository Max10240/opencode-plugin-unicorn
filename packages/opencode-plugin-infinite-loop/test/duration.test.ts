import { describe, expect, test } from "bun:test"
import {
  DAY_MS,
  formatDuration,
  HOUR_MS,
  MINUTE_MS,
  parseCooldown,
  parseDuration,
  parsePresets,
  SECOND_MS,
} from "../src/duration.js"

const BOUNDS = { minMs: 5 * MINUTE_MS, maxMs: 7 * DAY_MS }

describe("parseDuration", () => {
  test("accepts unit suffixes", () => {
    const seconds = { minMs: SECOND_MS, maxMs: 7 * DAY_MS }
    expect(parseDuration("30s", seconds)).toEqual({ ok: true, ms: 30 * SECOND_MS })
    expect(parseDuration("30m", BOUNDS)).toEqual({ ok: true, ms: 30 * MINUTE_MS })
    expect(parseDuration("2h", BOUNDS)).toEqual({ ok: true, ms: 2 * HOUR_MS })
    expect(parseDuration("1d", BOUNDS)).toEqual({ ok: true, ms: 1 * DAY_MS })
  })

  test("accepts compound units", () => {
    expect(parseDuration("1h30m", BOUNDS)).toEqual({ ok: true, ms: HOUR_MS + 30 * MINUTE_MS })
    expect(parseDuration("2d12h", BOUNDS)).toEqual({ ok: true, ms: 2 * DAY_MS + 12 * HOUR_MS })
    expect(parseDuration("90m", BOUNDS)).toEqual({ ok: true, ms: 90 * MINUTE_MS })
  })

  test("treats bare numbers as hours", () => {
    expect(parseDuration("2", BOUNDS)).toEqual({ ok: true, ms: 2 * HOUR_MS })
    expect(parseDuration("2 h", BOUNDS)).toEqual({ ok: true, ms: 2 * HOUR_MS })
  })

  test("is case and whitespace tolerant", () => {
    expect(parseDuration(" 1H30M ", BOUNDS)).toEqual({ ok: true, ms: HOUR_MS + 30 * MINUTE_MS })
  })

  test("rejects invalid input", () => {
    expect(parseDuration("abc", BOUNDS).ok).toBe(false)
    expect(parseDuration("2x", BOUNDS).ok).toBe(false)
    expect(parseDuration("h2", BOUNDS).ok).toBe(false)
    expect(parseDuration("1h extra", BOUNDS).ok).toBe(false)
    expect(parseDuration("", BOUNDS).ok).toBe(false)
    expect(parseDuration("0h", BOUNDS).ok).toBe(false)
  })

  test("enforces bounds", () => {
    expect(parseDuration("4m", BOUNDS).ok).toBe(false)
    expect(parseDuration("8d", BOUNDS).ok).toBe(false)
    const tight = { minMs: MINUTE_MS, maxMs: HOUR_MS }
    expect(parseDuration("30m", tight)).toEqual({ ok: true, ms: 30 * MINUTE_MS })
    expect(parseDuration("2h", tight).ok).toBe(false)
  })
})

describe("parseCooldown", () => {
  const cooldown = { minMs: 0, maxMs: DAY_MS }

  test("treats bare numbers as minutes", () => {
    expect(parseCooldown("5", cooldown)).toEqual({ ok: true, ms: 5 * MINUTE_MS })
    expect(parseCooldown("1", cooldown)).toEqual({ ok: true, ms: MINUTE_MS })
  })

  test("accepts zero and unit suffixes", () => {
    expect(parseCooldown("0", cooldown)).toEqual({ ok: true, ms: 0 })
    expect(parseCooldown("0m", cooldown)).toEqual({ ok: true, ms: 0 })
    expect(parseCooldown("90s", cooldown)).toEqual({ ok: true, ms: 90 * SECOND_MS })
    expect(parseCooldown("1h30m", cooldown)).toEqual({ ok: true, ms: HOUR_MS + 30 * MINUTE_MS })
  })

  test("rejects invalid input and bounds", () => {
    expect(parseCooldown("abc", cooldown).ok).toBe(false)
    expect(parseCooldown("2x", cooldown).ok).toBe(false)
    expect(parseCooldown("2d", cooldown).ok).toBe(false)
    expect(parseCooldown("-1", cooldown).ok).toBe(false)
  })
})

describe("formatDuration", () => {
  test("formats compact human durations", () => {
    expect(formatDuration(30 * MINUTE_MS)).toBe("30m")
    expect(formatDuration(HOUR_MS + 30 * MINUTE_MS)).toBe("1h 30m")
    expect(formatDuration(2 * DAY_MS + 12 * HOUR_MS)).toBe("2d 12h")
    expect(formatDuration(45_000)).toBe("45s")
    expect(formatDuration(0)).toBe("0s")
  })
})

describe("parsePresets", () => {
  test("keeps valid unique presets in order", () => {
    expect(parsePresets(["15m", "1h", "1H", "2h"], BOUNDS)).toEqual(["15m", "1h", "2h"])
  })

  test("drops invalid entries", () => {
    expect(parsePresets(["15m", "nope", "8d", 42, null], BOUNDS)).toEqual(["15m"])
  })

  test("returns empty for non-arrays", () => {
    expect(parsePresets(undefined, BOUNDS)).toEqual([])
    expect(parsePresets("15m", BOUNDS)).toEqual([])
  })
})
