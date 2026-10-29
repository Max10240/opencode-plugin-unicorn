import { expect, setDefaultTimeout, test } from "bun:test"
import { access, chmod, copyFile, cp, link, lstat, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { syncRecommendedRules } from "../scripts/sync-recommended-rules.mjs"
import { createOpenCodeE2E } from "../packages/opencode-plugin-unicorn/test/e2e-utils.js"
import { api, createSession, waitFor } from "../packages/opencode-plugin-show-img/test/e2e-utils.js"

setDefaultTimeout(60_000)

async function fixture(run: (root: string) => Promise<void>) {
  const root = await mkdtemp(path.join(os.tmpdir(), "opencode-rules-link-"))
  try { await run(root) } finally { await rm(root, { recursive: true, force: true }) }
}

test("re-establishes a hard link after the source was atomically replaced", async () => {
  await fixture(async (root) => {
    const source = path.join(root, "source.md")
    const target = path.join(root, "template.md")
    await writeFile(source, "# Original\n")
    await link(source, target)
    const { rename } = await import("node:fs/promises")
    await writeFile(`${source}.new`, "# Updated\n")
    await rename(`${source}.new`, source)
    expect((await stat(source)).ino).not.toBe((await stat(target)).ino)
    expect(await syncRecommendedRules({ source, target })).toBe(true)
    expect((await stat(source)).ino).toBe((await stat(target)).ino)
    expect(await readFile(target, "utf8")).toBe("# Updated\n")
    expect(await syncRecommendedRules({ source, target })).toBe(false)
  })
})

test("a symlinked source or template is converted to a regular hard-linked file", async () => {
  await fixture(async (root) => {
    const original = path.join(root, "original.md")
    const source = path.join(root, "source.md")
    const target = path.join(root, "template.md")
    await writeFile(original, "# Original\n")
    await symlink(original, source)
    await symlink(original, target)
    expect(await syncRecommendedRules({ source, target })).toBe(true)
    expect((await lstat(target)).isSymbolicLink()).toBe(false)
    expect((await stat(original)).ino).toBe((await stat(target)).ino)
  })
})

test("npm prepack refreshes the hard link and embeds its current content in a Node-loadable tarball", async () => {
  await fixture(async (root) => {
    const source = path.join(root, "source.md")
    await writeFile(source, "### Packaged Rule\n\nPackaged description\n")
    const packageRoot = path.join(root, "packages/opencode-plugin-recomended-opencode-config")
    const original = path.resolve(import.meta.dir, "../packages/opencode-plugin-recomended-opencode-config")
    await cp(original, packageRoot, { recursive: true, filter: (file) => !["node_modules", "dist"].includes(path.basename(file)) })
    await symlink(path.join(original, "node_modules"), path.join(packageRoot, "node_modules"))
    await mkdir(path.join(root, "scripts"))
    await copyFile(new URL("../scripts/sync-recommended-rules.mjs", import.meta.url), path.join(root, "scripts/sync-recommended-rules.mjs"))
    await copyFile(new URL("../scripts/sync-recommended-commands.mjs", import.meta.url), path.join(root, "scripts/sync-recommended-commands.mjs"))
    await symlink(path.resolve(import.meta.dir, "../node_modules"), path.join(root, "node_modules"))
    const commandsSource = path.join(root, "opencode.jsonc")
    const literalFile = path.join(root, "literal-file.txt")
    await writeFile(literalFile, "SYNTHETIC_FILE_VALUE")
    const inlineCommands = {
      fixture: { template: "Fixture $ARGUMENTS", description: "Fixture command" },
      "inline-variables": { template: `INLINE_CONFIG {file:${literalFile}}` },
    }
    await writeFile(commandsSource, JSON.stringify({ commands: inlineCommands, providers: { private: { apiKey: "DO_NOT_EXPORT_THIS" } } }))
    await mkdir(path.join(root, ".commands/team"), { recursive: true })
    const marker = path.join(root, "command-was-executed")
    const template = `PACKAGED_MARKDOWN $ARGUMENTS\nPOSITIONS $1 | $2\nLITERAL {env:OPENCODE_COMMAND_LITERAL}\nFILE {file:${literalFile}}\nSHELL !\`touch '${marker}'\``
    await writeFile(path.join(root, ".commands/team/markdown.md"), `---\ndescription: Packaged Markdown command\nagent: compaction-e2e\nsubagent: false\nprivate: DO_NOT_EXPORT_THIS\n---\n${template}\n`)
    const fixtureCommands = { ...inlineCommands, "team/markdown": { template, description: "Packaged Markdown command", agent: "compaction-e2e", subagent: false } }
    const run = (args: string[], cwd = packageRoot) => {
      const result = Bun.spawnSync(args, { cwd, env: { ...process.env, RECOMMENDED_RULES_SOURCE: source, RECOMMENDED_COMMANDS_SOURCE: commandsSource, RECOMMENDED_COMMANDS_DIR: "" }, stdout: "pipe", stderr: "pipe" })
      if (result.exitCode !== 0) throw new Error(`${args[0]} failed: ${result.stderr}`)
      return result.stdout.toString()
    }
    const packed = JSON.parse(run(["npm", "pack", "--json", "--pack-destination", root]))[0]
    expect((await stat(source)).ino).toBe((await stat(path.join(packageRoot, "rules/AGENTS.md"))).ino)
    expect(packed.files.every((file: { path: string }) => file.path === "package.json" || file.path === "README.md" || file.path === "README.zh-CN.md" || file.path.endsWith(".js"))).toBe(true)
    const unpack = path.join(root, "unpack")
    await mkdir(unpack)
    run(["tar", "-xzf", path.join(root, packed.filename), "-C", unpack], root)
    await symlink(path.join(original, "node_modules"), path.join(unpack, "package/node_modules"))
    const output = run(["node", "--input-type=module", "-e", "const p = await import(process.argv[1]); console.log(JSON.stringify({rules:p.recommendedRules,commands:p.recommendedCommands}))", path.join(unpack, "package/dist/src/index.js")], root)
    expect(JSON.parse(output)).toEqual({ rules: [{ title: "Packaged Rule", description: "Packaged description" }], commands: fixtureCommands })
    expect(output).not.toContain("DO_NOT_EXPORT_THIS")
    expect(output).not.toContain("SYNTHETIC_FILE_VALUE")
    await expect(access(marker)).rejects.toThrow()
    const e2e = await createOpenCodeE2E({ plugin: "recommended-config", pluginPackage: path.join(unpack, "package/dist"), pluginOptions: { enabled: true } })
    try {
      await e2e.waitForModelContext(200_000)
      await waitFor(async () => {
        const result = await api<{ data: Array<{ name: string; description?: string }> }>(e2e, `/api/command?${new URLSearchParams({ directory: e2e.workspace })}`)
        return result.data.some((command) => command.name === "team/markdown" && command.description === "Packaged Markdown command")
      }, "Packaged Markdown command was not registered")
      await expect(access(marker)).rejects.toThrow()
      const sessionID = await createSession(e2e)
      await api(e2e, `/api/session/${sessionID}/command`, { name: "team/markdown", text: 'src/auth.ts "error handling" extra' })
      await api(e2e, `/api/experimental/session/${sessionID}/wait`, {})
      await access(marker)
      expect(JSON.stringify(e2e.proxy.requests)).toContain("POSITIONS src/auth.ts | error handling extra")
      expect(JSON.stringify(e2e.proxy.requests)).not.toContain("$ARGUMENTS")
      expect(JSON.stringify(e2e.proxy.requests)).toContain("LITERAL {env:OPENCODE_COMMAND_LITERAL}")
      expect(JSON.stringify(e2e.proxy.requests)).toContain(`FILE {file:${literalFile}}`)
      expect(JSON.stringify(e2e.proxy.requests)).not.toContain("SYNTHETIC_FILE_VALUE")
      const inlineSession = await createSession(e2e)
      await api(e2e, `/api/session/${inlineSession}/command`, { name: "inline-variables", text: "" })
      await api(e2e, `/api/experimental/session/${inlineSession}/wait`, {})
      expect(JSON.stringify(e2e.proxy.requests)).toContain("INLINE_CONFIG SYNTHETIC_FILE_VALUE")
    } finally { await e2e.close() }
  })
})

test("hook installation preserves existing hooks without breaking dependency installation", async () => {
  await fixture(async (root) => {
    await mkdir(path.join(root, "scripts"))
    await copyFile(new URL("../scripts/install-hooks.mjs", import.meta.url), path.join(root, "scripts/install-hooks.mjs"))
    const global = path.join(root, "git-global")
    const run = (args: string[]) => Bun.spawnSync(args, { cwd: root, env: { ...process.env, GIT_CONFIG_GLOBAL: global, GIT_CONFIG_NOSYSTEM: "1" }, stdout: "pipe", stderr: "pipe" })
    expect(run(["git", "init", "-q"]).exitCode).toBe(0)
    expect(run(["node", "scripts/install-hooks.mjs"]).exitCode).toBe(0)
    expect(run(["git", "config", "--local", "--get", "core.hooksPath"]).stdout.toString().trim()).toBe(".githooks")
    run(["git", "config", "--local", "core.hooksPath", ".custom-hooks"])
    expect(run(["node", "scripts/install-hooks.mjs"]).exitCode).toBe(0)
    expect(run(["git", "config", "--local", "--get", "core.hooksPath"]).stdout.toString().trim()).toBe(".custom-hooks")
    run(["git", "config", "--local", "--unset", "core.hooksPath"])
    const hook = path.join(root, ".git/hooks/pre-commit")
    await writeFile(hook, "# existing hook\n")
    expect(run(["node", "scripts/install-hooks.mjs"]).exitCode).toBe(0)
    expect(await readFile(hook, "utf8")).toBe("# existing hook\n")
    await rm(hook)
    await writeFile(global, "[core]\n\thooksPath = /corporate/hooks\n")
    expect(run(["node", "scripts/install-hooks.mjs"]).exitCode).toBe(0)
    expect(run(["git", "config", "--get", "core.hooksPath"]).stdout.toString().trim()).toBe("/corporate/hooks")
    expect(run(["git", "config", "--local", "--get", "core.hooksPath"]).exitCode).not.toBe(0)
  })
})

test("source archives without Git metadata can still install dependencies", async () => {
  await fixture(async (root) => {
    await mkdir(path.join(root, "scripts"))
    await copyFile(new URL("../scripts/install-hooks.mjs", import.meta.url), path.join(root, "scripts/install-hooks.mjs"))
    const result = Bun.spawnSync(["node", "scripts/install-hooks.mjs"], { cwd: root, stdout: "pipe", stderr: "pipe" })
    expect(result.exitCode).toBe(0)
  })
})

test("installing a source archive inside another repository never changes the parent's hooks", async () => {
  await fixture(async (root) => {
    const archive = path.join(root, "archive")
    await mkdir(path.join(archive, "scripts"), { recursive: true })
    await copyFile(new URL("../scripts/install-hooks.mjs", import.meta.url), path.join(archive, "scripts/install-hooks.mjs"))
    const environment = { ...process.env, GIT_CONFIG_GLOBAL: path.join(root, "git-global"), GIT_CONFIG_NOSYSTEM: "1" }
    expect(Bun.spawnSync(["git", "init", "-q"], { cwd: root, env: environment }).exitCode).toBe(0)
    expect(Bun.spawnSync(["node", "scripts/install-hooks.mjs"], { cwd: archive, env: environment, stdout: "pipe", stderr: "pipe" }).exitCode).toBe(0)
    expect(Bun.spawnSync(["git", "config", "--local", "--get", "core.hooksPath"], { cwd: root, env: environment }).exitCode).not.toBe(0)
  })
})

test("a checkout without the author's global file can build using its committed template", async () => {
  await fixture(async (root) => {
    const target = path.join(root, "template.md")
    await writeFile(target, "# Packaged\n")
    expect(await syncRecommendedRules({ source: path.join(root, "missing.md"), target })).toBe(false)
    await expect(syncRecommendedRules({ source: path.join(root, "missing.md"), target: path.join(root, "missing-target.md") })).rejects.toThrow("both missing")
  })
})

test("the pre-commit hook stages file contents and not a path, and refreshes the source link", async () => {
  await fixture(async (root) => {
    const source = path.join(root, "author.md")
    await writeFile(source, "# Author rule\n\nBody\n")
    await mkdir(path.join(root, "scripts"))
    await mkdir(path.join(root, ".githooks"))
    const template = path.join(root, "packages/opencode-plugin-recomended-opencode-config/rules/AGENTS.md")
    await mkdir(path.dirname(template), { recursive: true })
    await writeFile(template, "# Stale\n")
    await copyFile(new URL("../scripts/sync-recommended-rules.mjs", import.meta.url), path.join(root, "scripts/sync-recommended-rules.mjs"))
    await copyFile(new URL("../scripts/sync-recommended-commands.mjs", import.meta.url), path.join(root, "scripts/sync-recommended-commands.mjs"))
    await symlink(path.resolve(import.meta.dir, "../node_modules"), path.join(root, "node_modules"))
    const commandsSource = path.join(root, "opencode.jsonc")
    await writeFile(commandsSource, '{"commands":{"fixture":{"template":"Fixture"}},"private":"DO_NOT_EXPORT_THIS"}')
    await copyFile(new URL("../.githooks/pre-commit", import.meta.url), path.join(root, ".githooks/pre-commit"))
    await chmod(path.join(root, ".githooks/pre-commit"), 0o755)
    const run = (args: string[]) => {
      const result = Bun.spawnSync(args, { cwd: root, env: { ...process.env, RECOMMENDED_RULES_SOURCE: source, RECOMMENDED_COMMANDS_SOURCE: commandsSource, RECOMMENDED_COMMANDS_DIR: "" }, stdout: "pipe", stderr: "pipe" })
      if (result.exitCode !== 0) throw new Error(result.stderr.toString())
      return result.stdout.toString()
    }
    run(["git", "init", "-q"])
    // Execute the hook without making any commit, including in the fixture repository.
    run(["sh", ".githooks/pre-commit"])
    expect(run(["git", "show", ":packages/opencode-plugin-recomended-opencode-config/rules/AGENTS.md"])).toBe(await readFile(source, "utf8"))
    expect(run(["git", "ls-files", "--stage"])).toStartWith("100644")
    expect((await stat(source)).ino).toBe((await stat(template)).ino)
    const snapshot = run(["git", "show", ":packages/opencode-plugin-recomended-opencode-config/rules/commands.json"])
    expect(JSON.parse(snapshot)).toEqual({ fixture: { template: "Fixture" } })
    expect(snapshot).not.toContain("DO_NOT_EXPORT_THIS")
  })
})
