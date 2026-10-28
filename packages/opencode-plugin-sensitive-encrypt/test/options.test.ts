import { expect, test } from "bun:test"
import os from "node:os"
import path from "node:path"
import { DEFAULT_KEY_DIRECTORY, DEFAULT_MAX_BYTES, globalConfigDirectory, parseOptions } from "../src/options.js"

test("uses independent encrypt/decrypt defaults and a safe size limit", () => {
  const options = parseOptions({}, { OPENCODE_CONFIG_DIR: "/tmp/opencode-config" })
  expect(options).toEqual({
    enabled: true,
    encrypt: true,
    decrypt: true,
    keyDirectory: path.join("/tmp/opencode-config", DEFAULT_KEY_DIRECTORY),
    maxBytes: DEFAULT_MAX_BYTES,
  })
  expect(parseOptions({ enabled: false }).encrypt).toBe(false)
  expect(parseOptions({ enabled: false }).decrypt).toBe(false)
  expect(parseOptions({ encrypt: false }).encrypt).toBe(false)
  expect(parseOptions({ decrypt: null }).decrypt).toBe(false)
})

test("resolves global, XDG and home paths consistently", () => {
  expect(globalConfigDirectory({ OPENCODE_CONFIG_DIR: "/isolated" }, "/home")).toBe("/isolated")
  expect(globalConfigDirectory({ XDG_CONFIG_HOME: "/xdg" }, "/home")).toBe("/xdg/opencode")
  expect(globalConfigDirectory({}, "/home")).toBe("/home/.config/opencode")
  expect(globalConfigDirectory({ OPENCODE_CONFIG_DIR: "", XDG_CONFIG_HOME: "" }, "/home")).toBe("/home/.config/opencode")
})

test("supports new key names and silently accepts the legacy public key names", () => {
  const config = "/tmp/opencode-config"
  const options = parseOptions({
    publicKeyForEncrypt: "PEM",
    privateKeyFileForDecrypt: "keys/private.pem",
  }, { OPENCODE_CONFIG_DIR: config })
  expect(options.publicKey).toBe("PEM")
  expect(options.privateKeyFile).toBe(path.join(config, "keys/private.pem"))

  const legacy = parseOptions({ publicKey: "LEGACY", publicKeyFile: undefined }, { OPENCODE_CONFIG_DIR: config })
  expect(legacy.publicKey).toBe("LEGACY")

  const file = parseOptions({ publicKeyFile: "keys/public.pem" }, { OPENCODE_CONFIG_DIR: config })
  expect(file.publicKeyFile).toBe(path.join(config, "keys/public.pem"))
})

test("rejects ambiguous, empty, or invalid configuration", () => {
  for (const value of [
    { publicKeyForEncrypt: "PEM", publicKeyFileForEncrypt: "public.pem" },
    { publicKeyForEncrypt: "" },
    { publicKeyForEncrypt: "   " },
    { publicKeyFileForEncrypt: "" },
    { privateKeyFileForDecrypt: "" },
    { maxBytes: 0 },
    { maxBytes: -1 },
    { maxBytes: 1.5 },
    { maxBytes: 64 * 1024 * 1024 + 1 },
  ]) expect(() => parseOptions(value)).toThrow()
  expect(parseOptions({ maxBytes: 64 * 1024 * 1024 }).maxBytes).toBe(64 * 1024 * 1024)
})
