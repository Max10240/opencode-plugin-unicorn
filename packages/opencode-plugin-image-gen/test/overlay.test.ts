import { expect, test } from "bun:test"
import { mergeHeaders, mergeOverlay } from "../src/overlay.js"

test("JSON keys never resolve through Object.prototype during recursive overlays", () => {
  const base = JSON.parse('{"constructor":"original","toString":"keep","nested":{"value":1},"__proto__":{"own":true}}')
  const overlay = JSON.parse('{"nested":{"next":2},"__proto__":{"next":true}}')
  const original = JSON.stringify(base)
  expect(mergeOverlay(base, overlay)).toEqual(JSON.parse('{"constructor":"original","toString":"keep","nested":{"value":1,"next":2},"__proto__":{"own":true,"next":true}}'))
  expect(JSON.stringify(base)).toBe(original)
  expect(Object.hasOwn(Object.prototype, "next")).toBe(false)
})

test("overlays replace arrays and null, preserve undefined defaults, and merge headers case-insensitively", () => {
  expect(mergeOverlay({ array: [1], nested: { before: true }, keep: "yes" }, { array: [2], nested: null, keep: undefined })).toEqual({ array: [2], nested: null, keep: "yes" })
  expect(mergeHeaders({ "X-Key": "base", Other: "keep" }, { "x-key": "variant" })).toEqual({ "x-key": "variant", Other: "keep" })
})
