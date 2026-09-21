import { expect, test } from "bun:test"
import { promptSearchFeatureEnabled } from "../src/options.js"

test("prompt search is enabled by default and can be disabled independently", () => {
  expect(promptSearchFeatureEnabled({})).toBe(true)
  expect(promptSearchFeatureEnabled({ features: { promptSearch: true } })).toBe(true)
  expect(promptSearchFeatureEnabled({ features: { promptSearch: false } })).toBe(false)
  expect(promptSearchFeatureEnabled({ features: { imageGen: false } })).toBe(true)
})
