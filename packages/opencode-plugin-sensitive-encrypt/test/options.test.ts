import { expect, test } from "bun:test"
import os from "node:os"
import path from "node:path"
import {
  DEFAULT_KEY_DIRECTORY,
  DEFAULT_MAX_BYTES,
  globalConfigDirectory,
  parseOptions,
} from "../src/options.js"

test("uses the global config key directory and safe defaults", () => {
  const options = parseOptions({}, { OPENCODE_CONFIG_DIR: "/tmp/opencode-config" })
  expect(options).toEqual({
    enabled: true,
    keyDirectory: path.join("/tmp/opencode-config", DEFAULT_KEY_DIRECTORY),
    maxBytes: DEFAULT_MAX_BYTES,
  })
  expect(parseOptions({ enabled: false }).enabled).toBe(false)
  expect(parseOptions({ enabled: "false" }).enabled).toBe(true)
})

test("resolves global, XDG and home paths consistently", () => {
  expect(globalConfigDirectory({ OPENCODE_CONFIG_DIR: "/isolated" }, "/home")).toBe("/isolated")
  expect(globalConfigDirectory({ XDG_CONFIG_HOME: "/xdg" }, "/home")).toBe("/xdg/opencode")
  expect(globalConfigDirectory({}, "/home")).toBe("/home/.config/opencode")
  expect(globalConfigDirectory({ OPENCODE_CONFIG_DIR: "", XDG_CONFIG_HOME: "" }, "/home")).toBe("/home/.config/opencode")
})

test("resolves public key files and key directories relative to the global config", () => {
  const config = "/tmp/opencode-config"
  const options = parseOptions({ publicKeyFile: "keys/public.pem", keyDirectory: "keys" }, { OPENCODE_CONFIG_DIR: config })
  expect(options.publicKeyFile).toBe(path.join(config, "keys/public.pem"))
  expect(options.keyDirectory).toBe(path.join(config, "keys"))
  expect(parseOptions({ publicKeyFile: "~/keys/public.pem" }).publicKeyFile).toBe(path.join(os.homedir(), "keys/public.pem"))
  expect(parseOptions({ keyDirectory: "~/keys" }).keyDirectory).toBe(path.join(os.homedir(), "keys"))
})

test("rejects ambiguous, empty, or invalid configuration", () => {
  for (const value of [
    { publicKey: "PEM", publicKeyFile: "public.pem" },
    { publicKey: "" },
    { publicKey: "   " },
    { publicKeyFile: "" },
    { keyDirectory: "" },
    { maxBytes: 0 },
    { maxBytes: -1 },
    { maxBytes: 1.5 },
    { maxBytes: 64 * 1024 * 1024 + 1 },
  ]) expect(() => parseOptions(value)).toThrow()
  expect(parseOptions({ maxBytes: 64 * 1024 * 1024 }).maxBytes).toBe(64 * 1024 * 1024)
})
