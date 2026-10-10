import { expect, test } from "bun:test"
import { chmod, lstat, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { parse } from "jsonc-parser"
import { applyRecommendedConfig, atomicUpdate, globalConfigDirectory, updateConfigText, updateOpenAIStore } from "../src/config.js"
import { recommendedConfigEnabled } from "../src/options.js"
import { symlinkSync, unlinkSync, writeFileSync } from "node:fs"

test("explicit switches override the environment; empty, zero and false flags do not enable it", () => {
  expect(recommendedConfigEnabled({}, {})).toBe(false)
  expect(recommendedConfigEnabled({}, { IS_MAX_SELF: "1" })).toBe(true)
  for (const value of ["", " ", "0", " 0 ", "false", " FALSE "]) {
    expect(recommendedConfigEnabled({}, { IS_MAX_SELF: value })).toBe(false)
    expect(recommendedConfigEnabled({ enabled: true }, { IS_MAX_SELF: value })).toBe(true)
  }
  expect(recommendedConfigEnabled({}, { IS_MAX_SELF: " true " })).toBe(true)
  expect(recommendedConfigEnabled({ enabled: true }, {})).toBe(true)
  expect(recommendedConfigEnabled({ enabled: false }, { IS_MAX_SELF: "1" })).toBe(false)
  expect(recommendedConfigEnabled({ enabled: "true" }, {})).toBe(false)
})

test("updates only the existing OpenAI store setting and preserves comments and unrelated configuration", () => {
  const text = `{
  // user comment
  "share": "manual",
  "providers": {
    "openai": { "settings": { "store": true, "baseURL": "https://example.test" }, "models": { "luna": { "limit": { "context": 123 } } } },
    "google": { "settings": { "store": true } }
  },
}\n`
  const result = updateOpenAIStore(text)
  expect(result).toContain("// user comment")
  const before = parse(text)
  const after = parse(result)
  before.providers.openai.settings.store = false
  expect(after).toEqual(before)
  expect(updateOpenAIStore(result)).toBe(result)
})

test("does not add OpenAI or a global config file when absent", () => {
  for (const text of ["{}\n", '{"providers":{"google":{}}}\n']) expect(updateOpenAIStore(text)).toBe(text)
  expect(parse(updateOpenAIStore('{"providers":{"openai":{}}}')).providers.openai.settings.store).toBe(false)
})

test("prototype-provided OpenAI keys are not treated as explicit provider configuration", () => {
  for (const text of ['{"__proto__":{"providers":{"openai":{}}}}', '{"providers":{"__proto__":{"openai":{}}}}']) {
    expect(updateOpenAIStore(text)).toBe(text)
  }
})

test("refuses malformed JSONC or malformed settings", () => {
  for (const text of ["not json", "{broken", "[]", '{"providers":{"openai":{"settings":false}}}']) {
    expect(() => updateOpenAIStore(text)).toThrow()
  }
})

test("resolves the server global config directory without project paths", () => {
  expect(globalConfigDirectory({ OPENCODE_CONFIG_DIR: "/isolated" }, "/home")).toBe("/isolated")
  expect(globalConfigDirectory({ XDG_CONFIG_HOME: "/xdg" }, "/home")).toBe("/xdg/opencode")
  expect(globalConfigDirectory({}, "/home")).toBe("/home/.config/opencode")
  expect(globalConfigDirectory({ OPENCODE_CONFIG_DIR: "", XDG_CONFIG_HOME: "" }, "/home")).toBe("/home/.config/opencode")
})

test("atomic updates preserve dotfile symlinks and permissions even under a restrictive umask", async () => {
  await fixture(async (directory) => {
    const target = path.join(directory, "dotfiles.jsonc")
    const file = path.join(directory, "opencode.jsonc")
    await writeFile(target, '{"providers":{"openai":{}}}')
    await chmod(target, 0o640)
    await symlink(target, file)
    const previous = process.umask(0o077)
    try { await atomicUpdate(file, updateOpenAIStore) } finally { process.umask(previous) }
    expect((await lstat(file)).isSymbolicLink()).toBe(true)
    expect(parse(await readFile(target, "utf8")).providers.openai.settings.store).toBe(false)
    expect((await stat(target)).mode & 0o777).toBe(0o640)
  })
})

test("dangling symlinks are never replaced with regular files", async () => {
  await fixture(async (directory) => {
    const file = path.join(directory, "AGENTS.md")
    await symlink(path.join(directory, "missing.md"), file)
    await expect(atomicUpdate(file, () => "new data", true)).rejects.toThrow("dangling")
    expect((await lstat(file)).isSymbolicLink()).toBe(true)
  })
})

test("a concurrent user command edit is re-read instead of overwritten", async () => {
  await fixture(async (directory) => {
    const file = path.join(directory, "opencode.jsonc")
    await writeFile(file, '{"commands":{}}')
    let attempts = 0
    await atomicUpdate(file, (text) => {
      if (++attempts === 1) writeFileSync(file, '{"commands":{"fixture":{"template":"USER_CONCURRENT"}}}')
      return updateConfigText(text, { fixture: { template: "RECOMMENDED" }, add: { template: "ADD" } })
    })
    expect(attempts).toBe(2)
    expect(parse(await readFile(file, "utf8")).commands).toEqual({ fixture: { template: "USER_CONCURRENT" }, add: { template: "ADD" } })
  })
})

test("a concurrently retargeted symlink is respected and its old target is not changed", async () => {
  await fixture(async (directory) => {
    const a = path.join(directory, "a.jsonc")
    const b = path.join(directory, "b.jsonc")
    const file = path.join(directory, "opencode.jsonc")
    await writeFile(a, "{}")
    await writeFile(b, '{"user":"B"}')
    await symlink(a, file)
    let attempts = 0
    await atomicUpdate(file, (text) => {
      if (++attempts === 1) { unlinkSync(file); symlinkSync(b, file) }
      return updateConfigText(text, { fixture: { template: "Fixture" } })
    })
    expect(attempts).toBe(2)
    expect(await readFile(a, "utf8")).toBe("{}")
    expect(parse(await readFile(b, "utf8"))).toEqual({ user: "B", commands: { fixture: { template: "Fixture" } } })
    expect((await lstat(file)).isSymbolicLink()).toBe(true)
  })
})

test("an empty existing JSON file is not treated as a missing file during creation", async () => {
  await fixture(async (directory) => {
    const file = path.join(directory, "opencode.jsonc")
    await writeFile(file, "")
    await expect(atomicUpdate(file, (text, exists) => updateConfigText(exists ? text : "{}", { fixture: { template: "Fixture" } }), true)).rejects.toThrow("invalid")
    expect(await readFile(file, "utf8")).toBe("")
  })
})

test("command deduplication is refreshed after a user adds a lower-priority definition during rule merging", async () => {
  await fixture(async (directory) => {
    const lower = path.join(directory, "opencode.json")
    const higher = path.join(directory, "opencode.jsonc")
    await writeFile(lower, "{}")
    await writeFile(higher, "{}")
    let injected = false
    const rule = {
      title: "New rule",
      get description() {
        if (!injected) {
          injected = true
          writeFileSync(lower, '{"commands":{"keep":{"template":"USER_CONCURRENT"}}}')
        }
        return "Body"
      },
    }
    await applyRecommendedConfig(directory, [rule], { keep: { template: "RECOMMENDED" }, add: { template: "ADD" } })
    expect(parse(await readFile(lower, "utf8")).commands.keep.template).toBe("USER_CONCURRENT")
    expect(parse(await readFile(higher, "utf8"))).toEqual({ commands: { add: { template: "ADD" } } })
  })
})

test("a dependency guard retries a stale write and leaves no temporary files", async () => {
  await fixture(async (directory) => {
    const file = path.join(directory, "opencode.jsonc")
    await writeFile(file, "{}")
    let transforms = 0
    let checks = 0
    await atomicUpdate(file, (text) => {
      transforms++
      return updateConfigText(text, { fixture: { template: "Fixture" } })
    }, false, async () => ++checks > 1)
    expect(transforms).toBe(2)
    expect(checks).toBe(2)
    expect((await readdir(directory)).filter((name) => name.endsWith(".tmp"))).toEqual([])
  })
})

test("inline commands are added without overwriting user definitions, comments, or unrelated data", () => {
  const text = '{\n// comment\n"commands":{"keep":{"template":"USER"}},"other":true\n}'
  const commands = { keep: { template: "RECOMMENDED" }, add: { template: "Add $ARGUMENTS", description: "Add" }, toString: { template: "Own-name command" } }
  const result = updateConfigText(text, commands)
  expect(result).toContain("// comment")
  const parsed = parse(result)
  expect(parsed.commands.keep.template).toBe("USER")
  expect(parsed.commands.add).toEqual(commands.add)
  expect(parsed.commands.toString).toEqual(commands.toString)
  expect(parsed.other).toBe(true)
  expect(updateConfigText(result, commands)).toBe(result)
})

test("existing commands in either JSON variant or a global Markdown directory are never shadowed", async () => {
  await fixture(async (directory) => {
    const { mkdir } = await import("node:fs/promises")
    await mkdir(path.join(directory, "commands/team"), { recursive: true })
    await writeFile(path.join(directory, "commands/team/review.md"), "User Markdown")
    await writeFile(path.join(directory, "opencode.json"), '{"commands":{"keep":{"template":"USER"}}}')
    await writeFile(path.join(directory, "opencode.jsonc"), '{}')
    const commands = { keep: { template: "RECOMMENDED" }, "team/review": { template: "RECOMMENDED" }, add: { template: "ADD" } }
    await applyRecommendedConfig(directory, [], commands)
    expect(parse(await readFile(path.join(directory, "opencode.jsonc"), "utf8"))).toEqual({ commands: { add: { template: "ADD" } } })
    expect(parse(await readFile(path.join(directory, "opencode.json"), "utf8"))).toEqual({ commands: { keep: { template: "USER" } } })
    expect(await readFile(path.join(directory, "commands/team/review.md"), "utf8")).toBe("User Markdown")
  })
})

test("command directory aliases, cycles, and dangling links preserve all existing command names", async () => {
  await fixture(async (directory) => {
    const { mkdir } = await import("node:fs/promises")
    const folder = path.join(directory, "commands")
    await mkdir(path.join(folder, "shared"), { recursive: true })
    await writeFile(path.join(folder, "shared/review.md"), "User review")
    await symlink(path.join(folder, "shared"), path.join(folder, "a"))
    await symlink(path.join(folder, "shared"), path.join(folder, "b"))
    await symlink(folder, path.join(folder, "loop"))
    await symlink(path.join(directory, "missing.md"), path.join(folder, "reserved.md"))
    await writeFile(path.join(directory, "opencode.jsonc"), "{}")
    const commands = Object.fromEntries(["a/review", "b/review", "shared/review", "reserved"].map((name) => [name, { template: "Do not override" }]))
    await applyRecommendedConfig(directory, [], commands)
    expect(await readFile(path.join(directory, "opencode.jsonc"), "utf8")).toBe("{}")
  })
})

test("missing JSON is created for inline commands only, never for an absent OpenAI provider", async () => {
  await fixture(async (directory) => {
    await applyRecommendedConfig(directory, [], { fixture: { template: "Fixture" } })
    expect(parse(await readFile(path.join(directory, "opencode.jsonc"), "utf8"))).toEqual({ commands: { fixture: { template: "Fixture" } } })
    expect(await readdir(directory)).toEqual(["opencode.jsonc"])
  })
})

test("unsafe Markdown is preserved while independent commands and OpenAI settings still update", async () => {
  await fixture(async (directory) => {
    const markdown = "# User\n\n```md\nunclosed"
    await writeFile(path.join(directory, "AGENTS.md"), markdown)
    await writeFile(path.join(directory, "opencode.jsonc"), '{"providers":{"openai":{"settings":{"store":true}}}}')
    const result = await applyRecommendedConfig(directory, [{ title: "New" }], { fixture: { template: "Fixture" } })
    expect(result.rulesChanged).toBe(false)
    expect(await readFile(path.join(directory, "AGENTS.md"), "utf8")).toBe(markdown)
    const config = parse(await readFile(path.join(directory, "opencode.jsonc"), "utf8"))
    expect(config.providers.openai.settings.store).toBe(false)
    expect(config.commands).toEqual({ fixture: { template: "Fixture" } })
  })
})

async function fixture(run: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "opencode-recommended-unit-"))
  try { await run(directory) } finally { await rm(directory, { recursive: true, force: true }) }
}

test("serializes concurrent updates, preserves permissions and makes a second run a true no-op", async () => {
  await fixture(async (directory) => {
    const file = path.join(directory, "opencode.jsonc")
    await writeFile(file, '{"providers":{"openai":{"settings":{"store":true}}}}\n', { mode: 0o600 })
    await writeFile(path.join(directory, "AGENTS.md"), "### User\n\nKeep\n")
    const results = await Promise.all(Array.from({ length: 5 }, () => applyRecommendedConfig(directory, [{ title: "Rule", description: "Rule body" }])))
    expect(results.filter((result) => result.rulesChanged)).toHaveLength(1)
    expect(results.filter((result) => result.configChanged.length)).toHaveLength(1)
    expect((await stat(file)).mode & 0o777).toBe(0o600)
    const before = await stat(file)
    expect(await applyRecommendedConfig(directory, [{ title: "Rule" }])).toEqual({ rulesChanged: false, configChanged: [] })
    expect((await stat(file)).mtimeMs).toBe(before.mtimeMs)
    expect(await readdir(directory)).toEqual(expect.arrayContaining(["opencode.jsonc", "AGENTS.md"]))
    expect((await readdir(directory)).some((file) => file.endsWith(".tmp"))).toBe(false)
  })
})

test("updates both existing JSON variants without creating absent variants or changing model limits", async () => {
  await fixture(async (directory) => {
    for (const file of ["opencode.json", "opencode.jsonc"]) await writeFile(path.join(directory, file), '{"providers":{"openai":{}}}')
    expect((await applyRecommendedConfig(directory, [{ title: "Rule" }])).configChanged).toHaveLength(2)
    for (const file of ["opencode.json", "opencode.jsonc"]) expect(parse(await readFile(path.join(directory, file), "utf8"))).toEqual({ providers: { openai: { settings: { store: false } } } })
  })
  await fixture(async (directory) => {
    await applyRecommendedConfig(directory, [{ title: "Rule" }])
    expect(await readdir(directory)).toEqual(["AGENTS.md"])
  })
})

test("invalid existing JSON prevents any writes", async () => {
  await fixture(async (directory) => {
    await writeFile(path.join(directory, "opencode.jsonc"), "{broken")
    await expect(applyRecommendedConfig(directory, [{ title: "Rule" }])).rejects.toThrow("invalid")
    expect(await readdir(directory)).toEqual(["opencode.jsonc"])
    expect(await readFile(path.join(directory, "opencode.jsonc"), "utf8")).toBe("{broken")
  })
})
