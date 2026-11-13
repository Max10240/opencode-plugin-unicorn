import { expect, test } from "bun:test"
import { DEFAULT_KEYBIND, resolveEnabled, resolveKeybind, usageEnabled } from "../src/options.js"

test("the plugin is auto by default and honors explicit switches", () => {
  expect(resolveEnabled(undefined)).toBe("auto")
  expect(resolveEnabled("auto")).toBe("auto")
  expect(resolveEnabled(true)).toBe(true)
  expect(resolveEnabled(false)).toBe(false)
  expect(usageEnabled({})).toBe(true)
  expect(usageEnabled({ enabled: true })).toBe(true)
  expect(usageEnabled({ enabled: false })).toBe(false)
  expect(usageEnabled({ features: { opencodeGoUsage: false } })).toBe(false)
  expect(usageEnabled({ features: { opencodeGoUsage: true } })).toBe(true)
})

test("there is no default keybind, and blank binds are ignored", () => {
  expect(resolveKeybind(undefined)).toBe(DEFAULT_KEYBIND)
  expect(resolveKeybind("  ")).toBe(false)
  expect(resolveKeybind(false)).toBe(false)
  expect(resolveKeybind("ctrl+shift+g")).toBe("ctrl+shift+g")
})
