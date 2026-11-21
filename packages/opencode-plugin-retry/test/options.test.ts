import { expect, test } from "bun:test"
import { DEFAULT_CONTINUE_TEXT, DEFAULT_INTERRUPT_TIMEOUT_MS, DEFAULT_KEYBIND, parseRetryOptions, retryEnabled } from "../src/options.js"

test("uses the F5, Continue, and 1 second defaults", () => {
  expect(parseRetryOptions()).toEqual({
    enabled: true,
    keybind: DEFAULT_KEYBIND,
    continueText: DEFAULT_CONTINUE_TEXT,
    timeoutMs: DEFAULT_INTERRUPT_TIMEOUT_MS,
  })
  expect(DEFAULT_KEYBIND).toBe("f5")
  expect(DEFAULT_CONTINUE_TEXT).toBe("Continue")
  expect(DEFAULT_INTERRUPT_TIMEOUT_MS).toBe(1_000)
})

test("accepts a custom keybind, disabled keybind, Continue text, and timeout", () => {
  expect(parseRetryOptions({ keybind: "ctrl+shift+r", continueText: "  Please continue.  ", timeoutMs: 2_500 })).toEqual({
    enabled: true,
    keybind: "ctrl+shift+r",
    continueText: "Please continue.",
    timeoutMs: 2_500,
  })
  expect(parseRetryOptions({ keybind: false }).keybind).toBe(false)
})

test("honors the Retry feature switch and enabled option", () => {
  expect(retryEnabled({})).toBe(true)
  expect(retryEnabled({ features: { retry: true } })).toBe(true)
  expect(retryEnabled({ features: { retry: false } })).toBe(false)
  expect(retryEnabled({ features: { imageGen: false } })).toBe(true)
  expect(retryEnabled({ enabled: false })).toBe(false)
  expect(parseRetryOptions({ enabled: false }).enabled).toBe(false)
})

test("rejects invalid options", () => {
  expect(() => parseRetryOptions({ keybind: "" })).toThrow("keybind")
  expect(() => parseRetryOptions({ keybind: 42 })).toThrow("keybind")
  expect(() => parseRetryOptions({ continueText: "   " })).toThrow("continueText")
  expect(() => parseRetryOptions({ continueText: null })).toThrow("continueText")
  for (const timeoutMs of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "1000", null]) {
    expect(() => parseRetryOptions({ timeoutMs })).toThrow("timeoutMs")
  }
})
