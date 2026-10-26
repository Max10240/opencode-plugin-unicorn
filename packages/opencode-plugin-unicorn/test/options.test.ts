import { expect, test } from "bun:test"
import { childContext, imageGenFeatureEnabled, promptSearchFeatureEnabled, recommendedConfigFeatureOption, sendMessageAcrossSessionsFeatureEnabled, sensitiveEncryptFeatureEnabled, sessionSearchFeatureEnabled, showImgFeatureEnabled, type ChildPlugin } from "../src/options.js"

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

test("sensitive encryption is enabled by default and can be disabled independently", () => {
  expect(sensitiveEncryptFeatureEnabled({})).toBe(true)
  expect(sensitiveEncryptFeatureEnabled({ sensitiveEncrypt: { publicKey: "PEM" } })).toBe(true)
  expect(sensitiveEncryptFeatureEnabled({ features: { sensitiveEncrypt: true } })).toBe(true)
  expect(sensitiveEncryptFeatureEnabled({ features: { sensitiveEncrypt: "true" } })).toBe(true)
  expect(sensitiveEncryptFeatureEnabled({ features: { sensitiveEncrypt: false } })).toBe(false)
})

test("recommended config's feature gate does not rewrite its nested enabled option", () => {
  expect(recommendedConfigFeatureOption({})).toBeUndefined()
  expect(recommendedConfigFeatureOption({ features: { recommendedOpencodeConfig: true } })).toBe(true)
  expect(recommendedConfigFeatureOption({ features: { recommendedOpencodeConfig: false } })).toBe(false)
  expect(recommendedConfigFeatureOption({ features: { recommendedOpencodeConfig: "false" } })).toBeUndefined()
  const options = { features: { recommendedOpencodeConfig: true }, recommendedOpencodeConfig: { enabled: false } }
  expect(childContext({ options }, "recommendedOpencodeConfig").options).toBe(options.recommendedOpencodeConfig)
})

test("every child receives exactly its own options, including unknown nested fields", () => {
  const names: ChildPlugin[] = ["recommendedOpencodeConfig", "sendMessageAcrossSessions", "imageGen", "showImg", "promptSearch", "sensitiveEncrypt", "sessionSearch"]
  const options = Object.freeze({
    features: Object.freeze({ imageGen: false }), model: "legacy-model", keybind: "legacy-key", maxPrompts: 99, sessionSearchKeybind: "legacy-search-key",
    ...Object.fromEntries(names.map((name) => [name, Object.freeze({ marker: name, future: { values: [1, 2] } })])),
  })
  const context = Object.freeze({ options, client: {} })
  for (const name of names) {
    const child = childContext(context, name)
    expect(child).not.toBe(context)
    expect(child.options === (options as Record<string, unknown>)[name]).toBe(true)
    expect(child.client).toBe(context.client)
    expect(child.options).not.toHaveProperty("features")
    expect(child.options).not.toHaveProperty("model")
  }
  expect(context.options).toBe(options)
})

test("missing or non-object child options never fall back to shared flat options", () => {
  for (const value of [undefined, null, false, "bad", 7, []]) {
    const context = { options: { keybind: "f12", sessionSearchKeybind: "f11", model: "flat", sessionSearch: value } }
    expect(childContext(context, "sessionSearch").options).toEqual({})
  }
  const context = { options: {} }
  const first = childContext(context, "imageGen")
  expect(first.options).not.toBe(childContext(context, "showImg").options)
})

test("scoping options preserves live host getters and does not change sibling contexts", () => {
  let theme = "dark"
  const context = { options: { promptSearch: { keybind: "f12" }, sessionSearch: { keybind: "f11" } }, get theme() { return theme } }
  const prompts = childContext(context, "promptSearch")
  const sessions = childContext(context, "sessionSearch")
  theme = "light"
  expect(prompts.theme).toBe("light")
  expect(sessions.theme).toBe("light")
  expect(prompts.options).toBe(context.options.promptSearch)
  expect(sessions.options).toBe(context.options.sessionSearch)
})

test("feature gates win over child options and remain independent", () => {
  const options = {
    features: { imageGen: false, showImg: false, promptSearch: false, sensitiveEncrypt: false, sessionSearch: false, sendMessageAcrossSessions: false, recommendedOpencodeConfig: false },
    recommendedOpencodeConfig: { enabled: true }, imageGen: { enabled: true }, sessionSearch: { keybind: "f11" },
  }
  expect(recommendedConfigFeatureOption(options)).toBe(false)
  for (const enabled of [imageGenFeatureEnabled, showImgFeatureEnabled, promptSearchFeatureEnabled, sessionSearchFeatureEnabled, sendMessageAcrossSessionsFeatureEnabled]) {
    expect(enabled(options)).toBe(false)
    expect(enabled({})).toBe(true)
  }
  expect(sensitiveEncryptFeatureEnabled(options)).toBe(false)
  expect(sensitiveEncryptFeatureEnabled({})).toBe(true)
})

test("show_img can be enabled and disabled independently of image generation and prompt search", () => {
  expect(showImgFeatureEnabled({})).toBe(true)
  expect(showImgFeatureEnabled({ features: { showImg: false } })).toBe(false)
  expect(showImgFeatureEnabled({ features: { imageGen: false, promptSearch: false } })).toBe(true)
})
