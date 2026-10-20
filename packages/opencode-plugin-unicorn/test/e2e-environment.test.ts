import { expect, test } from "bun:test"
import path from "node:path"
import { e2eEnvironment } from "./e2e-environment.js"

test("E2E servers inherit only runtime essentials, never live auth, proxy, config, or preload overrides", () => {
  const root = path.resolve("isolated-test-home")
  const parent = {
    PATH: "/usr/bin:/bin", TMPDIR: "/test-tmp", LANG: "en_US.UTF-8", HOME: "CANARY_REAL_HOME",
    OPENAI_API_KEY: "CANARY_REAL_OPENAI", META_API_KEY: "CANARY_REAL_META", AWS_SECRET_ACCESS_KEY: "CANARY_REAL_AWS",
    GOOGLE_APPLICATION_CREDENTIALS: "CANARY_REAL_GOOGLE", HTTPS_PROXY: "CANARY_REAL_PROXY",
    OPENCODE_CONFIG: "CANARY_REAL_CONFIG", OPENCODE_CONFIG_CONTENT: "CANARY_REAL_CONFIG_CONTENT",
    OPENCODE_CLI_CONFIG_CONTENT: "CANARY_REAL_CLI", NODE_OPTIONS: "CANARY_REAL_PRELOAD", BUN_OPTIONS: "CANARY_REAL_BUN",
    XDG_DATA_HOME: "CANARY_REAL_DATA", IS_MAX_SELF: "CANARY_REAL_SELF",
  }
  const env = e2eEnvironment({ root, configDirectory: path.join(root, "config"), password: "synthetic-password" }, parent)
  expect(JSON.stringify(env)).not.toContain("CANARY_REAL")
  expect(env.PATH).toBe(parent.PATH)
  expect(env.TMPDIR).toBe(parent.TMPDIR)
  expect(env.HOME).toBe(root)
  expect(env.OPENCODE_DB).toBe(path.join(root, "opencode.db"))
  expect(env.OPENAI_API_KEY).toBe("e2e-image-key")
  expect(env.IS_MAX_SELF).toBeUndefined()
})

test("only the test's explicit self-config option enables recommended config", () => {
  const input = { root: "/isolated", configDirectory: "/isolated/config", password: "synthetic-password" }
  expect(e2eEnvironment({ ...input, isMaxSelf: "1" }, { IS_MAX_SELF: "0" }).IS_MAX_SELF).toBe("1")
  expect(e2eEnvironment({ ...input, isMaxSelf: "0" }, { IS_MAX_SELF: "1" }).IS_MAX_SELF).toBe("0")
})
