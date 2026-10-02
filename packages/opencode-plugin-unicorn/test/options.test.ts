import { expect, test } from "bun:test"
import { promptSearchFeatureEnabled, showImgFeatureEnabled } from "../src/options.js"

test("prompt search is enabled by default and can be disabled independently", () => {
  expect(promptSearchFeatureEnabled({})).toBe(true)
  expect(promptSearchFeatureEnabled({ features: { promptSearch: true } })).toBe(true)
  expect(promptSearchFeatureEnabled({ features: { promptSearch: false } })).toBe(false)
  expect(promptSearchFeatureEnabled({ features: { imageGen: false } })).toBe(true)
})

test("show_img can be enabled and disabled independently of image generation and prompt search", () => {
  expect(showImgFeatureEnabled({})).toBe(true)
  expect(showImgFeatureEnabled({ features: { showImg: false } })).toBe(false)
  expect(showImgFeatureEnabled({ features: { imageGen: false, promptSearch: false } })).toBe(true)
})
