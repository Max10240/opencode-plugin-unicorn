import { expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { publishAll, publishOptions } from "../scripts/publish.mjs"
import { buildFingerprint, workspacePackages } from "../scripts/workspace.mjs"
import { fileURLToPath } from "node:url"

async function fixture(callback: (value: any) => Promise<void>) {
  const root = await mkdtemp(path.join(os.tmpdir(), "unicorn-publish-test-"))
  try {
    await mkdir(path.join(root, "scripts"))
    await mkdir(path.join(root, "test"))
    await writeFile(path.join(root, "package.json"), JSON.stringify({ name: "fixture", private: true, workspaces: ["packages/*"] }))
    const child = "@max10240/opencode-plugin-show-img"
    for (const [directory, name] of [["child", child], ["unicorn", "@max10240/opencode-plugin-unicorn"]]) {
      const target = path.join(root, "packages", directory)
      await mkdir(path.join(target, "dist"), { recursive: true })
      await writeFile(path.join(target, "source.ts"), "validated source")
      await writeFile(path.join(target, "dist/index.js"), "validated build")
      await writeFile(path.join(target, "package.json"), JSON.stringify({ name, version: "1.0.9", scripts: { prepack: "npm run build" }, ...(directory === "unicorn" ? { dependencies: { [child]: "1.0.9" } } : {}) }))
    }
    const calls: Array<{ args: string[]; cwd: string; env: Record<string, string> }> = []
    const validations: any[] = []
    const controls: any = {}
    const run = async (args: string[], options: any) => {
      calls.push({ args: [...args], cwd: options.cwd, env: options.env })
      if (args[0] === "npm" && args[1] === "version") {
        for (const item of await workspacePackages(options.cwd)) {
          item.manifest.version = "1.0.10"
          if (options.cwd === root && controls.manifestChange) item.manifest.unexpected = true
          await writeFile(path.join(item.directory, "package.json"), JSON.stringify(item.manifest))
        }
        if (options.cwd === root && controls.versionSourceChange) await writeFile(path.join(root, "packages/child/source.ts"), "changed by version hook")
        return ""
      }
      if (args[1] === "whoami") {
        if (controls.authSourceChange) await writeFile(path.join(root, "packages/child/source.ts"), "changed while authenticating")
        if (controls.authError) throw new Error(controls.authError)
        return "fixture-user\n"
      }
      if (args[1] === "config") return controls.ignoreScripts ? "true\n" : "false\n"
      if (args[1] === "login" || args[1] === "publish" || args.join(" ") === "bun run build") return ""
      throw new Error(`Unexpected command: ${args.join(" ")}`)
    }
    const check = async (mode: string, options: any) => {
      validations.push({ mode, ...options })
      if (controls.checkError) throw new Error("validation failed")
      return { root, fingerprint: await buildFingerprint(root) }
    }
    const options = { root, run, check, env: {}, log: () => {} }
    const version = async () => JSON.parse(await readFile(path.join(root, "packages/unicorn/package.json"), "utf8")).version
    await callback({ root, calls, validations, controls, options, version })
  } finally { await rm(root, { recursive: true, force: true }) }
}

test("dry-run requests cannot be negated into a real publication", () => {
  expect(publishOptions(["--dry-run", "--no-dry-run"], {}).dryRun).toBe(true)
  expect(publishOptions(["--dry-run=false"], { npm_config_dry_run: "true" }).dryRun).toBe(true)
  expect(publishOptions(["--dry", "--tag=prerelease"], {}).dryRun).toBe(true)
  expect(publishOptions(["--dry-run=false"], {}).dryRun).toBe(false)
  expect(publishOptions(["--dry-run", "--tag=prerelease"], {}).npmArgs).toEqual(["--tag=prerelease"])
  for (const value of ["", "0", "1", "yes"]) {
    expect(publishOptions([`--dry-run=${value}`, "--no-dry-run"], {}).dryRun).toBe(true)
    expect(publishOptions([`--dry=${value}`], {}).dryRun).toBe(true)
  }
  for (const value of ["0", "1", "yes"]) expect(publishOptions([], { npm_config_dry_run: value }).dryRun).toBe(true)
  expect(publishOptions(["--dry-run", "0"], {}).dryRun).toBe(true)
  expect(publishOptions(["--dry-run", "false"], {}).dryRun).toBe(false)
  expect(publishOptions([], { npm_config_dry_run: "false" }).dryRun).toBe(false)
  expect(publishOptions([], { NPM_CONFIG_DRY_RUN: "true" }).dryRun).toBe(true)
  expect(publishOptions(["--no-dry-run=false"], {}).dryRun).toBe(true)
  expect(publishOptions(["--no-no-dry-run"], {}).dryRun).toBe(true)
  expect(publishOptions(["--dry-run", "--no-dry-run=true"], {}).dryRun).toBe(true)
  expect(publishOptions(["--no-dry-run=true"], {}).dryRun).toBe(false)
  for (const name of ["dr", "dry", "dry-", "dry-r", "dry-ru", "dry-run"]) {
    expect(publishOptions([`--${name}`, "--no-dry-run"], {}).dryRun).toBe(true)
    expect(publishOptions([`--no-${name}=false`], {}).dryRun).toBe(true)
  }
})

test("published workspaces retain their formal prepack builds", async () => {
  for (const item of await workspacePackages(fileURLToPath(new URL("../", import.meta.url)))) {
    if (item.manifest.private) continue
    expect(item.manifest.scripts.prepack).toMatch(/(?:^|&&\s*)(?:npm|bun) run build\s*$/)
  }
})

test("whole-pipeline dry run validates once and changes only a temporary version plan", async () => fixture(async ({ root, calls, validations, options, version }) => {
  const before = await buildFingerprint(root)
  const result = await publishAll({ ...options, args: ["--dry-run", "--tag=prerelease"] })
  expect(result).toEqual({ dryRun: true, version: "1.0.10" })
  expect(validations).toHaveLength(1)
  expect(validations[0].mode).toBe("check")
  expect(validations[0].fresh).toBe(true)
  expect(await version()).toBe("1.0.9")
  expect(await buildFingerprint(root)).toBe(before)
  expect(calls).toHaveLength(1)
  expect(calls[0].args).toContain("--git-tag-version=false")
  expect(calls[0].args).toContain("--workspaces-update=false")
  expect(calls[0].cwd).not.toBe(root)
}))

test("npm dry-run settings do not prevent validation commands from creating local artifacts", async () => fixture(async ({ root, calls, options }) => {
  await publishAll({ ...options, env: { npm_config_dry_run: "true", PRESERVED: "parent" }, check: async (_mode: string, validation: any) => {
    await validation.run(["bun", "run", "build"], { cwd: root })
    await validation.run(["bun", "run", "build"], { cwd: root, env: { NPM_CONFIG_DRY_RUN: "true", PRESERVED: "stage" } })
    return { root, fingerprint: await buildFingerprint(root) }
  } })
  const builds = calls.filter((call: any) => call.args.join(" ") === "bun run build")
  expect(builds.map((call: any) => call.env.PRESERVED)).toEqual(["parent", "stage"])
  for (const call of builds) {
    expect(call.env.npm_config_dry_run).toBe("false")
    expect(call.env.NPM_CONFIG_DRY_RUN).toBe("false")
  }
  expect(calls.some((call: any) => ["whoami", "login", "publish"].includes(call.args[1]))).toBe(false)
}))

test("authenticated publication keeps prepack but removes the duplicate build and login", async () => fixture(async ({ root, calls, validations, options, version }) => {
  await publishAll({ ...options, args: ["--tag=prerelease"] })
  expect(validations).toHaveLength(1)
  expect(await version()).toBe("1.0.10")
  const manifest = JSON.parse(await readFile(path.join(root, "packages/unicorn/package.json"), "utf8"))
  expect(manifest.dependencies["@max10240/opencode-plugin-show-img"]).toBe("1.0.10")
  expect(calls.some((call: any) => call.args[1] === "login")).toBe(false)
  expect(calls.some((call: any) => call.args.join(" ") === "bun run build")).toBe(false)
  const published = calls.find((call: any) => call.args[1] === "publish")!
  expect(published.args).toContain("--tag=prerelease")
  expect(published.args).toContain("--ignore-scripts=false")
}))

test("missing authentication logs in once before bumping the real workspace", async () => fixture(async ({ root, calls, controls, options }) => {
  controls.authError = "ENEEDAUTH"
  await publishAll(options)
  const login = calls.findIndex((call: any) => call.args[1] === "login")
  const bump = calls.findIndex((call: any) => call.args[1] === "version" && call.cwd === root)
  expect(login).toBeGreaterThanOrEqual(0)
  expect(bump).toBeGreaterThan(login)
  expect(calls.filter((call: any) => call.args[1] === "login")).toHaveLength(1)
}))

test("authentication network errors never open login, bump versions or publish", async () => fixture(async ({ root, calls, controls, options, version }) => {
  controls.authError = "ETIMEDOUT"
  await expect(publishAll(options)).rejects.toThrow("ETIMEDOUT")
  expect(await version()).toBe("1.0.9")
  expect(calls.some((call: any) => ["login", "publish"].includes(call.args[1]) || (call.args[1] === "version" && call.cwd === root))).toBe(false)
}))

test("validation failure prevents all release commands", async () => fixture(async ({ calls, controls, options, version }) => {
  controls.checkError = true
  await expect(publishAll(options)).rejects.toThrow("validation failed")
  expect(calls).toEqual([])
  expect(await version()).toBe("1.0.9")
}))

test("source changes during authentication stop release before the actual version bump", async () => fixture(async ({ calls, controls, options, version }) => {
  controls.authSourceChange = true
  await expect(publishAll(options)).rejects.toThrow("stale")
  expect(await version()).toBe("1.0.9")
  expect(calls.some((call: any) => call.args[1] === "publish")).toBe(false)
}))

for (const change of ["manifestChange", "versionSourceChange"]) {
  test(`${change} in a version hook cannot publish unvalidated changes`, async () => fixture(async ({ calls, controls, options }) => {
    controls[change] = true
    await expect(publishAll(options)).rejects.toThrow(change === "manifestChange" ? "Unexpected manifest" : "changed after validation")
    expect(calls.some((call: any) => call.args[1] === "publish")).toBe(false)
  }))
}

test("intentionally disabled prepack retains exactly one post-bump build", async () => fixture(async ({ calls, controls, options }) => {
  controls.ignoreScripts = true
  await publishAll(options)
  expect(calls.filter((call: any) => call.args.join(" ") === "bun run build")).toHaveLength(1)
  expect(calls.find((call: any) => call.args[1] === "publish")!.args).toContain("--ignore-scripts=true")
}))

test("explicit prepack enable overrides an ignore-scripts npm setting", async () => fixture(async ({ calls, controls, options }) => {
  controls.ignoreScripts = true
  await publishAll({ ...options, args: ["--ignore-scripts=false"] })
  expect(calls.some((call: any) => call.args.join(" ") === "bun run build")).toBe(false)
  expect(calls.find((call: any) => call.args[1] === "publish")!.args.at(-1)).toBe("--ignore-scripts=false")
}))

test("npm boolean spellings do not accidentally enable disabled lifecycle hooks", async () => fixture(async ({ calls, options }) => {
  await publishAll({ ...options, args: ["--ignore-scripts=0"] })
  expect(calls.filter((call: any) => call.args.join(" ") === "bun run build")).toHaveLength(1)
  expect(calls.find((call: any) => call.args[1] === "publish")!.args.at(-1)).toBe("--ignore-scripts=true")
  expect(calls.find((call: any) => call.args[1] === "publish")!.args).not.toContain("--ignore-scripts=0")
}))
