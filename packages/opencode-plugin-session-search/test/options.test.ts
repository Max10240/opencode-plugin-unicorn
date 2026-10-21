import { expect, test } from "bun:test"
import { DEFAULT_KEYBIND, resolveSearchKeybind, sessionSearchEnabled } from "../src/options.js"

test("only an explicit false disables session search", () => {
  expect(sessionSearchEnabled({})).toBe(true)
  expect(sessionSearchEnabled({ features: null })).toBe(true)
  expect(sessionSearchEnabled({ features: { sessionSearch: false } })).toBe(false)
  expect(sessionSearchEnabled({ features: { sessionSearch: "false" } })).toBe(true)
  expect(sessionSearchEnabled({ features: { promptSearch: false } })).toBe(true)
  expect(resolveSearchKeybind("")).toBe(DEFAULT_KEYBIND)
  expect(resolveSearchKeybind(undefined)).toBe(DEFAULT_KEYBIND)
  expect(resolveSearchKeybind(" f11 ")).toBe("f11")
})
