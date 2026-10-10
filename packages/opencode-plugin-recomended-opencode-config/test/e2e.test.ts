import { expect, setDefaultTimeout, test } from "bun:test"
import { access, chmod, lstat, mkdir, readFile, rename, stat, symlink, writeFile } from "node:fs/promises"
import path from "node:path"
import { createOpenCodeE2E } from "../../opencode-plugin-unicorn/test/e2e-utils.js"
import { api, createSession, prompt, waitFor } from "../../opencode-plugin-show-img/test/e2e-utils.js"
import { checkRecommendedConfig } from "./e2e-utils.js"
import { RULES_HEADING } from "../src/rules.js"
import { recommendedCommands, recommendedRules } from "../src/index.js"

setDefaultTimeout(180_000)

for (const mode of ["standalone", "unicorn"] as const) {
  for (const scenario of ["default-off", "env-on", "env-empty", "env-zero", "env-false", "explicit-on", "explicit-off"] as const) {
    test(`${mode}: ${scenario} obeys explicit configuration before IS_MAX_SELF`, async () => {
      const enabled = scenario === "env-on" || scenario === "explicit-on"
      const explicit = scenario === "explicit-on" ? true : scenario === "explicit-off" ? false : undefined
      const e2e = await createOpenCodeE2E({
        plugin: mode === "standalone" ? "recommended-config" : "unicorn",
        pluginPackage: path.resolve(import.meta.dir, mode === "standalone" ? "../dist" : "../../opencode-plugin-unicorn/dist"),
        pluginOptions: mode === "standalone" ? { enabled: explicit } : { features: { recommendedOpencodeConfig: explicit, promptSearch: false } },
        isMaxSelf: scenario === "env-empty" ? "" : scenario === "env-zero" ? "0" : scenario === "env-false" ? "false" : scenario === "env-on" || scenario === "explicit-off" ? "1" : undefined,
        initialRules: "## Existing User Rules\n\nKeep user instructions\n",
        share: "manual",
        configure: (config) => {
          config.commands = { [Object.keys(recommendedCommands)[0]]: { template: "USER_COMMAND_TEMPLATE" }, "user-only-command": { template: "USER_ONLY" } }
          config.providers.openai.settings.store = true
          config.providers.openai.models["gpt-5.6-luna"].package = "@opencode/ai/providers/openai/chat"
        },
      })
      try {
        if (enabled) await checkRecommendedConfig(e2e)
        else {
          await e2e.waitForModelContext(200_000)
          const initial = await e2e.config()
          expect(initial.providers.openai.settings.store).toBe(true)
          expect(initial.share).toBe("manual")
          expect(Object.keys(initial.commands)).toHaveLength(2)
          expect(await readFile(path.join(e2e.configDirectory, "AGENTS.md"), "utf8")).toBe("## Existing User Rules\n\nKeep user instructions\n")
          const sessionID = await createSession(e2e)
          await prompt(e2e, sessionID, "E2E_CONFIG_DISABLED")
          expect(JSON.stringify(e2e.proxy.requests)).not.toContain(RULES_HEADING)
        }
      } finally { await e2e.close() }
    })
  }
}

test("Unicorn hot reload enables and disables recommendations without disabling image_gen", async () => {
  const e2e = await createOpenCodeE2E({
    featureEnabled: false, isMaxSelf: "1",
    initialRules: "# User\n\nKeep user instructions\n", share: "manual",
    configure: (config) => { config.providers.openai.settings.store = true },
  })
  try {
    await e2e.waitForModelContext(200_000)
    expect((await e2e.config()).providers.openai.settings.store).toBe(true)
    const enable = await e2e.config()
    enable.plugins[0].options.features.recommendedOpencodeConfig = true
    await writeFile(e2e.configPath, JSON.stringify(enable))
    await waitFor(async () => (await e2e.config()).providers.openai.settings.store === false, "Hot reload did not enable recommended config")
    expect(await readFile(path.join(e2e.configDirectory, "AGENTS.md"), "utf8")).toContain(`# ${RULES_HEADING}`)

    const disable = await e2e.config()
    disable.plugins[0].options.features.recommendedOpencodeConfig = false
    disable.providers.openai.settings.store = true
    await writeFile(e2e.configPath, JSON.stringify(disable))
    await e2e.runImagePrompt()
    expect((await e2e.config()).providers.openai.settings.store).toBe(true)
    expect(e2e.proxy.imageRequests).toBe(1)
  } finally { await e2e.close() }
})

test("an absent OpenAI key or JSON variant is not created", async () => {
  const e2e = await createOpenCodeE2E({
    plugin: "recommended-config", pluginPackage: path.resolve(import.meta.dir, "../dist"), pluginOptions: { enabled: true },
    initialRules: "# User\n", configure: (config) => { config.providers = { custom: {} } },
  })
  try {
    await api(e2e, `/api/plugin?${new URLSearchParams({ directory: e2e.workspace })}`)
    await waitFor(async () => (await readFile(path.join(e2e.configDirectory, "AGENTS.md"), "utf8")).includes(RULES_HEADING), "Rules were not merged without OpenAI")
    expect((await e2e.config()).providers.openai).toBeUndefined()
    await expect(access(path.join(e2e.configDirectory, "opencode.json"))).rejects.toThrow()
    await waitFor(async () => {
      const plugins = await api<{ data: Array<{ id: string; state: { status: string } }> }>(e2e, `/api/plugin?${new URLSearchParams({ directory: e2e.workspace })}`)
      return plugins.data.some((entry) => entry.id === "max10240.recomended-opencode-config" && entry.state.status === "active")
    }, "Recommended config did not reactivate after the config reload")
  } finally { await e2e.close() }
})

test("a rules merge failure does not disable other Unicorn plugins or rewrite user files", async () => {
  const e2e = await createOpenCodeE2E({
    featureEnabled: true, initialRules: "# User rules\n\nKeep original\n",
    configure: (config) => { config.providers.openai.settings.store = true },
  })
  try {
    await chmod(e2e.configDirectory, 0o500)
    await e2e.runImagePrompt()
    expect(e2e.proxy.imageRequests).toBe(1)
    expect((await e2e.config()).providers.openai.settings.store).toBe(true)
    expect(await readFile(path.join(e2e.configDirectory, "AGENTS.md"), "utf8")).toBe("# User rules\n\nKeep original\n")
  } finally { await chmod(e2e.configDirectory, 0o700); await e2e.close() }
})

test("a valid IS_MAX_SELF enables a level-6 document and restarting does not duplicate its nested rules", async () => {
  const e2e = await createOpenCodeE2E({
    plugin: "recommended-config", pluginPackage: path.resolve(import.meta.dir, "../dist"), isMaxSelf: "1",
    initialRules: "###### User\n\nKeep original\n",
    configure: (config) => { config.providers.openai.settings.store = true },
  })
  try {
    await e2e.waitForModelContext(200_000)
    await waitFor(async () => (await e2e.config()).providers.openai.settings.store === false, "Valid environment flag did not enable the plugin")
    const file = path.join(e2e.configDirectory, "AGENTS.md")
    const text = await readFile(file, "utf8")
    expect(text).toContain(`###### ${RULES_HEADING}`)
    for (const rule of recommendedRules) expect(text).toContain(`- **${rule.title}**`)
    expect(text).not.toContain("####### ")
    const before = await stat(file)
    await e2e.restart()
    await e2e.waitForModelContext(200_000)
    expect(await readFile(file, "utf8")).toBe(text)
    expect((await stat(file)).mtimeMs).toBe(before.mtimeMs)
  } finally { await e2e.close() }
})

test("unclosed user Markdown never grows and does not block inline commands, storage settings, or image generation", async () => {
  const markdown = "# User\n\n```md\nunclosed"
  const e2e = await createOpenCodeE2E({
    featureEnabled: true, initialRules: markdown,
    configure: (config) => { config.providers.openai.settings.store = true },
  })
  try {
    await e2e.runImagePrompt()
    const config = await e2e.config()
    expect(config.providers.openai.settings.store).toBe(false)
    expect(config.commands).toEqual(recommendedCommands)
    expect(e2e.proxy.imageRequests).toBe(1)
    expect(await readFile(path.join(e2e.configDirectory, "AGENTS.md"), "utf8")).toBe(markdown)
    await e2e.restart()
    await e2e.waitForModelContext(200_000)
    expect(await readFile(path.join(e2e.configDirectory, "AGENTS.md"), "utf8")).toBe(markdown)
  } finally { await e2e.close() }
})

test("linked dotfiles remain linked and OpenCode observes the recommended rules, commands, and store setting", async () => {
  const e2e = await createOpenCodeE2E({
    featureEnabled: true, share: "manual", initialRules: "## Existing User Rules\n\nKeep user instructions\n",
    configure: (config) => {
      config.providers.openai.settings.store = true
      config.providers.openai.models["gpt-5.6-luna"].package = "@opencode/ai/providers/openai/chat"
      config.commands = { [Object.keys(recommendedCommands)[0]]: { template: "USER_COMMAND_TEMPLATE" }, "user-only-command": { template: "USER_ONLY" } }
    },
    beforeStart: async ({ root, configDirectory, configPath }) => {
      const dotfiles = path.join(root, "dotfiles")
      await mkdir(dotfiles)
      for (const file of [configPath, path.join(configDirectory, "AGENTS.md")]) {
        const target = path.join(dotfiles, path.basename(file))
        await rename(file, target)
        await symlink(target, file)
      }
    },
  })
  try {
    await checkRecommendedConfig(e2e)
    expect((await lstat(e2e.configPath)).isSymbolicLink()).toBe(true)
    expect((await lstat(path.join(e2e.configDirectory, "AGENTS.md"))).isSymbolicLink()).toBe(true)
  } finally { await e2e.close() }
})
