import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { isDeepStrictEqual } from "node:util"
import { executeWorkflow } from "./workflow.mjs"
import { buildFingerprint, workspacePackages } from "./workspace.mjs"
import { assertPluginVersions, checkPluginVersions } from "./check-versions.mjs"
import { syncPluginDependencies } from "./sync-plugin-dependencies.mjs"
import { installerEnvironment, verifyBuild } from "./test-artifacts.mjs"
import { runCommand, timed } from "./process.mjs"

const repository = fileURLToPath(new URL("../", import.meta.url))
export const VERSION_COMMAND = ["npm", "version", "--workspaces", "patch", "--git-tag-version=false", "--workspaces-update=false", "--include-workspace-root=false", "--update-notifier=false"]

function booleanOption(args, index) {
  const match = /^--((?:no-)*)(dry-run|dry-ru|dry-r|dry-|dry|dr|ignore-scripts)(?:=(.*))?$/.exec(args[index])
  if (!match) return
  const separate = match[3] === undefined && ["true", "false"].includes(args[index + 1])
  const value = (match[3] ?? (separate ? args[index + 1] : undefined)) !== "false"
  return { name: match[2], value: match[1].length / 3 % 2 ? !value : value, consumed: separate ? 1 : 0 }
}

export function publishOptions(args = [], env = process.env) {
  // A requested dry run cannot be overridden into a real publication by later arguments.
  let dryRun = [env.npm_config_dry_run, env.NPM_CONFIG_DRY_RUN].some((value) => Boolean(value) && value !== "false")
  let ignoreScripts
  const npmArgs = []
  let registry = "https://registry.npmjs.org/"
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]
    const boolean = booleanOption(args, index)
    if (boolean) {
      if (boolean.name === "ignore-scripts") ignoreScripts = boolean.value
      else dryRun ||= boolean.value
      index += boolean.consumed
      continue
    }
    if (arg === "--registry") registry = args[index + 1] ?? ""
    if (arg.startsWith("--registry=")) registry = arg.slice("--registry=".length)
    npmArgs.push(arg)
  }
  const url = new URL(registry)
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("Publish registry must be HTTP or HTTPS")
  return { dryRun, ignoreScripts, npmArgs, registry: url.href }
}

export async function planVersionBump(root, { run = runCommand } = {}) {
  const packages = await workspacePackages(root)
  const before = assertPluginVersions(packages.map((item) => item.manifest)).version
  const directory = await mkdtemp(path.join(os.tmpdir(), "unicorn-publish-plan-"))
  try {
    await writeFile(path.join(directory, "package.json"), JSON.stringify({ name: "unicorn-publish-plan", private: true, workspaces: ["packages/*"] }))
    const original = new Map()
    for (const item of packages) {
      const target = path.join(directory, "packages", path.basename(item.directory))
      await mkdir(target, { recursive: true })
      const file = path.join(item.directory, "package.json")
      const bytes = await readFile(file)
      original.set(file, bytes)
      await writeFile(path.join(target, "package.json"), bytes)
    }
    const env = installerEnvironment(directory)
    await writeFile(env.npm_config_userconfig, "")
    await writeFile(env.npm_config_globalconfig, "")
    await run([...VERSION_COMMAND, "--ignore-scripts"], { cwd: directory, env, capture: true })
    const after = await syncPluginDependencies(directory)
    const expected = new Map()
    for (const item of await workspacePackages(directory)) expected.set(path.basename(item.directory), item.manifest)
    return { before, after: after.version, original, expected }
  } finally { await rm(directory, { recursive: true, force: true }) }
}

async function verifyVersionOnlyChange(root, plan, proof) {
  for (const item of await workspacePackages(root)) {
    if (!isDeepStrictEqual(item.manifest, plan.expected.get(path.basename(item.directory)))) {
      throw new Error(`Unexpected manifest change during release: ${item.manifest.name}`)
    }
  }
  if (await buildFingerprint(root, plan.original) !== proof.fingerprint) throw new Error("Source or build output changed after validation; release stopped")
}

export async function publishAll({ root = repository, args = [], env = process.env, run = runCommand, check = executeWorkflow, log = console.log } = {}) {
  const options = publishOptions(args, env)
  const started = performance.now()
  try {
    // Validation must create real local archives even when npm itself requested a dry run.
    const validate = (command, options = {}) => run(command, {
      ...options, env: { ...(options.env ?? env), npm_config_dry_run: "false", NPM_CONFIG_DRY_RUN: "false" },
    })
    const proof = await timed("release validation", () => check("check", { root, run: validate, fresh: true }))
    await verifyBuild(root, proof)
    const plan = await planVersionBump(root, { run })
    await verifyBuild(root, proof)
    if (options.dryRun) {
      log(`[publish] DRY RUN: ${plan.before} -> ${plan.after}; actual package versions unchanged`)
      log(`[publish] Would authenticate if needed, bump/sync versions, then npm publish --workspaces ${options.npmArgs.join(" ")}`)
      log("[publish] No login, actual version bump, Git commit/tag or registry upload performed")
      return { dryRun: true, version: plan.after }
    }
    try {
      await run(["npm", "whoami", `--registry=${options.registry}`, "--update-notifier=false"], { cwd: root, env, capture: true })
    } catch (error) {
      if (!/ENEEDAUTH|E401|E403/.test(String(error))) throw error
      await run(["npm", "login", `--registry=${options.registry}`], { cwd: root, env })
    }
    const configured = await run(["npm", "config", "get", "ignore-scripts", "--update-notifier=false"], { cwd: root, env, capture: true })
    const ignoreScripts = options.ignoreScripts ?? (configured.trim() !== "" && configured.trim() !== "false")
    await verifyBuild(root, proof)
    await run(VERSION_COMMAND, { cwd: root, env })
    await syncPluginDependencies(root)
    await checkPluginVersions(root)
    await verifyVersionOnlyChange(root, plan, proof)
    // Normal npm publication builds in prepack. Keep one explicit build only when hooks are intentionally disabled.
    if (ignoreScripts) await run(["bun", "run", "build"], { cwd: root, env })
    await run(["npm", "publish", "--workspaces", `--registry=${options.registry}`, "--update-notifier=false", ...options.npmArgs, `--ignore-scripts=${ignoreScripts}`], { cwd: root, env })
    return { dryRun: false, version: plan.after }
  } finally { log(`[publish] total: ${((performance.now() - started) / 1000).toFixed(2)}s`) }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2)
    if (args.includes("--help") || args.includes("-h")) console.log("npm run publish:all -- [--dry-run] [--tag=prerelease]\nDry run validates everything and simulates the bump without login, real version changes or publication.")
    else await publishAll({ args })
  }
  catch (error) { console.error(error); process.exitCode = 1 }
}
