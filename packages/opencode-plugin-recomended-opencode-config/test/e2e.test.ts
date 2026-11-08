import { expect, setDefaultTimeout, test } from "bun:test"
import { access, chmod, lstat, mkdir, readFile, rename, stat, symlink, writeFile } from "node:fs/promises"
import path from "node:path"
import { createOpenCodeE2E } from "../../opencode-plugin-unicorn/test/e2e-utils.js"
import { api, createSession, prompt, waitFor } from "../../opencode-plugin-show-img/test/e2e-utils.js"
import { checkRecommendedConfig } from "./e2e-utils.js"
import { RULES_HEADING } from "../src/rules.js"
import { recommendedCommands, recommendedRules } from "../src/index.js"

setDefaultTimeout(180_000)

// The full environment/option matrix is covered by recommendedConfigEnabled unit tests.
// E2E covers representative initial-load wiring for each mode.
for (const mode of ["standalone", "unicorn"] as const) {
  for (const scenario of ["default-off", "env-on"] as const) {
    test(`${mode}: ${scenario} initial load follows the default or IS_MAX_SELF`, async () => {
      const enabled = scenario === "env-on"
      const e2e = await createOpenCodeE2E({
        plugin: mode === "standalone" ? "recommended-config" : "unicorn",
        pluginPackage: path.resolve(import.meta.dir, mode === "standalone" ? "../dist" : "../../opencode-plugin-unicorn/dist"),
        pluginOptions: mode === "standalone" ? {} : { recommendedOpencodeConfig: {}, features: { promptSearch: false } },
        isMaxSelf: scenario === "env-on" ? "1" : undefined,
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

    const nestedOff = await e2e.config()
    nestedOff.plugins[0].options.recommendedOpencodeConfig = { enabled: false }
    nestedOff.providers.openai.settings.store = true
    await writeFile(e2e.configPath, JSON.stringify(nestedOff))
    await waitFor(async () => (await e2e.config()).providers.openai.settings.store === true, "Nested enabled=false did not override the feature gate")

    const featureOff = await e2e.config()
    featureOff.plugins[0].options.features.recommendedOpencodeConfig = false
    featureOff.plugins[0].options.recommendedOpencodeConfig = { enabled: true }
    featureOff.providers.openai.settings.store = true
    await writeFile(e2e.configPath, JSON.stringify(featureOff))
    await waitFor(async () => (await e2e.config()).providers.openai.settings.store === true, "Feature=false did not override nested enabled=true")

    const bothOn = await e2e.config()
    bothOn.plugins[0].options.features.recommendedOpencodeConfig = true
    bothOn.plugins[0].options.recommendedOpencodeConfig = { enabled: true }
    bothOn.providers.openai.settings.store = true
    await writeFile(e2e.configPath, JSON.stringify(bothOn))
    await waitFor(async () => (await e2e.config()).providers.openai.settings.store === false, "Both gates enabled did not apply recommended config")

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
    featureEnabled: true, pluginOptions: { recommendedOpencodeConfig: { enabled: true } }, initialRules: "# User rules\n\nKeep original\n",
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

test("linked dotfiles remain linked and OpenCode observes the recommended rules, commands, and store setting", async () => {
  const e2e = await createOpenCodeE2E({
    featureEnabled: true, pluginOptions: { recommendedOpencodeConfig: { enabled: true } }, share: "manual", initialRules: "## Existing User Rules\n\nKeep user instructions\n",
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
