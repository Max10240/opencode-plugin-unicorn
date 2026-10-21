import { expect, test } from "bun:test"
import { promptSearchFeatureEnabled, recommendedConfigFeatureOption, sessionSearchFeatureEnabled, showImgFeatureEnabled } from "../src/options.js"

test("prompt search is enabled by default and can be disabled independently", () => {
  expect(promptSearchFeatureEnabled({})).toBe(true)
  expect(promptSearchFeatureEnabled({ features: { promptSearch: true } })).toBe(true)
  expect(promptSearchFeatureEnabled({ features: { promptSearch: false } })).toBe(false)
  expect(promptSearchFeatureEnabled({ features: { imageGen: false } })).toBe(true)
})

test("session search is independently enabled and never disables prompt search or previews", () => {
  expect(sessionSearchFeatureEnabled({})).toBe(true)
  expect(sessionSearchFeatureEnabled({ features: { sessionSearch: false } })).toBe(false)
  expect(sessionSearchFeatureEnabled({ features: { promptSearch: false, imageGen: false } })).toBe(true)
  expect(promptSearchFeatureEnabled({ features: { sessionSearch: false } })).toBe(true)
  expect(showImgFeatureEnabled({ features: { sessionSearch: false } })).toBe(true)
})

test("recommended config forwards explicit switches and otherwise defers to the standalone plugin", () => {
  expect(recommendedConfigFeatureOption({})).toBeUndefined()
  expect(recommendedConfigFeatureOption({ features: { recommendedOpencodeConfig: true } })).toBe(true)
  expect(recommendedConfigFeatureOption({ features: { recommendedOpencodeConfig: false } })).toBe(false)
  expect(recommendedConfigFeatureOption({ features: { recommendedOpencodeConfig: "false" } })).toBeUndefined()
})

test("show_img can be enabled and disabled independently of image generation and prompt search", () => {
  expect(showImgFeatureEnabled({})).toBe(true)
  expect(showImgFeatureEnabled({ features: { showImg: false } })).toBe(false)
  expect(showImgFeatureEnabled({ features: { imageGen: false, promptSearch: false } })).toBe(true)
})
