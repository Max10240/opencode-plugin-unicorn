#!/usr/bin/env node
import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { runCommand } from "./process.mjs"
import { installArchives, packWorkspace } from "./test-artifacts.mjs"
import { workspacePackages } from "./workspace.mjs"

const repository = fileURLToPath(new URL("../", import.meta.url))
const defaultDirectory = path.join(repository, ".local", "unicorn-shadow")
const SNAPSHOT = "snapshot.json"
const PLUGIN = "@max10240/opencode-plugin-unicorn"
// OpenCode supplies effect, @opencode/plugin, and the TUI runtime from its own process.
// image-gen embeds @opencode/ai, so none of these need a copy in the shadow snapshot.
const PRUNED_MODULES = new Set([
  "effect",
  "@opencode/plugin",
  "@opencode/ai",
  "@opentui/core",
  "@opentui/solid",
  "solid-js",
  "web-tree-sitter",
])
const LEFTOVER_MAX_AGE = 60 * 60 * 1_000

function usage() {
  console.log(`Usage: node scripts/unicorn-shadow.mjs <command> [--dir <path>] [--full]

Commands:
  update   Build and pack the workspace, install a snapshot, and replace the shadow copy.
           Host-supplied or bundled dependencies and unused npm trees are pruned by default.
           Pass --full to keep the complete npm dependency tree.
  status   Show the installed snapshot and the OpenCode config path.
  verify   Load the snapshot with the installed OpenCode binary in a temporary config.
  clean    Remove the shadow copy and any leftover update directories.

The default directory is ${defaultDirectory}.
Set UNICORN_SHADOW_DIR or pass --dir to use another location.`)
}

function parse(argv) {
  const [command = "status", ...rest] = argv
  let directory = process.env.UNICORN_SHADOW_DIR ? path.resolve(process.env.UNICORN_SHADOW_DIR) : defaultDirectory
  let full = false
  for (let index = 0; index < rest.length; index++) {
    if (rest[index] === "--dir") {
      const value = rest[++index]
      if (!value) throw new Error("--dir requires a path")
      directory = path.resolve(value)
    } else if (rest[index] === "--full") {
      full = true
    } else if (rest[index] === "--help" || rest[index] === "-h") {
      return { command: "help", directory, full }
    } else {
      throw new Error(`Unknown argument: ${rest[index]}`)
    }
  }
  return { command, directory, full }
}

async function exists(target) {
  try {
    await stat(target)
    return true
  } catch {
    return false
  }
}

async function readJSON(file) {
  return JSON.parse(await readFile(file, "utf8"))
}

async function writeJSON(file, value) {
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`)
}

async function git(args) {
  return (await runCommand(["git", ...args], { cwd: repository, capture: true })).trim()
}

async function validate(directory, packages, { full = false } = {}) {
  const manifest = await readJSON(path.join(directory, "package.json"))
  if (manifest.name !== PLUGIN) throw new Error(`Unexpected package name in snapshot: ${manifest.name}`)
  const expected = new Map(packages.map((item) => [item.manifest.name, item.manifest.version]))
  if (manifest.version !== expected.get(PLUGIN)) throw new Error(`Unexpected Unicorn version: ${manifest.version}`)
  for (const target of Object.values(manifest.exports ?? {})) {
    const file = path.resolve(directory, target)
    if (!file.startsWith(`${path.resolve(directory)}${path.sep}`)) throw new Error(`Export escapes the snapshot: ${target}`)
    if (!(await exists(file))) throw new Error(`Missing export target: ${target}`)
  }
  for (const [name, version] of expected) {
    if (name === PLUGIN) continue
    const installed = await readJSON(path.join(directory, "node_modules", name, "package.json")).catch(() => undefined)
    if (!installed) throw new Error(`Missing local dependency: ${name}`)
    if (installed.version !== version) throw new Error(`Version mismatch for ${name}: ${installed.version} != ${version}`)
  }
  if (!full) {
    for (const name of PRUNED_MODULES) {
      if (await exists(path.join(directory, "node_modules", name))) throw new Error(`Unexpected pruned dependency: ${name}`)
    }
  }
  const files = await readdir(directory)
  if (files.some((file) => file.endsWith(".tgz"))) throw new Error("Snapshot contains a pack artifact")
  return manifest
}

async function manifestsUnder(nodeModules) {
  const manifests = new Map()
  const walk = async (directory) => {
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => [])
    if (entries.some((entry) => entry.name === "package.json" && entry.isFile())) {
      try {
        const manifest = await readJSON(path.join(directory, "package.json"))
        if (manifest.name) manifests.set(directory, manifest)
      } catch {}
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name === ".bin") continue
      await walk(path.join(directory, entry.name))
    }
  }
  await walk(nodeModules)
  return manifests
}

// Keep only the runtime closure of the packed packages. OpenCode supplies effect,
// @opencode/plugin and the TUI runtime; image-gen embeds @opencode/ai. Their npm trees
// are large and would otherwise be duplicated inside the shadow snapshot.
export async function prune(nodeModules, packages) {
  const manifests = await manifestsUnder(nodeModules)
  const keep = new Set()
  const pending = packages.flatMap((item) => [item.manifest.name, ...Object.keys(item.manifest.peerDependencies ?? {})])
  while (pending.length > 0) {
    const name = pending.pop()
    if (!name || keep.has(name) || PRUNED_MODULES.has(name) || name.startsWith("effect/")) continue
    keep.add(name)
    for (const [directory, manifest] of manifests) {
      if (manifest.name !== name) continue
      for (const field of ["dependencies", "optionalDependencies"]) {
        for (const dependency of Object.keys(manifest[field] ?? {})) pending.push(dependency)
      }
    }
  }
  // Peers of the local packages are roots above. Peers of third-party packages are optional,
  // build-time, or type-only, so they must not pull packages back after the closure is computed.
  const keptDirectories = new Set()
  for (const [directory, manifest] of manifests) {
    if (!keep.has(manifest.name)) continue
    let current = directory
    while (current.startsWith(nodeModules) && current !== path.dirname(current)) {
      keptDirectories.add(current)
      current = path.dirname(current)
    }
  }
  const removed = []
  const entries = await readdir(nodeModules, { withFileTypes: true })
  for (const entry of entries) {
    if (entry.name === ".bin") {
      await rm(path.join(nodeModules, entry.name), { recursive: true, force: true })
      continue
    }
    if (!entry.isDirectory()) continue
    const target = path.join(nodeModules, entry.name)
    if (entry.name.startsWith("@")) {
      for (const child of await readdir(target)) {
        const childTarget = path.join(target, child)
        if (keptDirectories.has(childTarget)) continue
        await rm(childTarget, { recursive: true, force: true })
        removed.push(`${entry.name}/${child}`)
      }
      if ((await readdir(target)).length === 0) await rm(target, { recursive: true, force: true })
      continue
    }
    if (keptDirectories.has(target)) continue
    await rm(target, { recursive: true, force: true })
    removed.push(entry.name)
  }
  return removed
}

function assertTarget(directory) {
  if (path.dirname(directory) === directory) throw new Error("Refusing to use a filesystem root as the shadow directory")
}

// A killed update can leave a work or previous directory behind. Only remove old ones
// so a concurrent update is never interrupted.
export async function cleanupLeftovers(directory) {
  const parent = path.dirname(directory)
  const base = path.basename(directory)
  const stable = await exists(directory)
  const entries = await readdir(parent, { withFileTypes: true }).catch(() => [])
  const removed = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const work = entry.name.startsWith(`.${base}.work-`)
    const previous = entry.name.startsWith(`.${base}.previous-`)
    if (!work && !previous) continue
    // A previous directory without a stable directory is the only remaining copy.
    if (previous && !stable) continue
    const target = path.join(parent, entry.name)
    const info = await stat(target).catch(() => undefined)
    if (!info || Date.now() - info.mtimeMs < LEFTOVER_MAX_AGE) continue
    await rm(target, { recursive: true, force: true })
    removed.push(entry.name)
  }
  return removed
}

export async function update(directory, { full = false } = {}) {
  assertTarget(directory)
  if (await exists(directory) && !(await exists(path.join(directory, SNAPSHOT)))) {
    throw new Error(`Refusing to replace ${directory}: ${SNAPSHOT} is missing`)
  }
  const packages = await workspacePackages(repository)
  if (packages.length === 0) throw new Error("No workspace packages found")
  const parent = path.dirname(directory)
  await mkdir(parent, { recursive: true })
  const leftovers = await cleanupLeftovers(directory)
  if (leftovers.length > 0) console.log(`[shadow] removed ${leftovers.length} stale update director${leftovers.length === 1 ? "y" : "ies"}`)
  const work = await mkdtemp(path.join(parent, `.${path.basename(directory)}.work-`))
  try {
    console.log(`[shadow] packing ${packages.length} workspace packages`)
    const archives = await packWorkspace(path.join(work, "archives"), { root: repository })
    if (archives.length !== packages.length) throw new Error(`Packed ${archives.length} of ${packages.length} packages`)
    const unicorn = archives.find((item) => item.manifest.name === PLUGIN)
    if (!unicorn) throw new Error(`Missing archive for ${PLUGIN}`)

    console.log("[shadow] installing packed packages")
    const install = path.join(work, "install")
    await installArchives(archives, install, { cache: undefined, fresh: true })
    if (full) {
      console.log("[shadow] keeping the full dependency tree")
    } else {
      const removed = await prune(path.join(install, "node_modules"), packages)
      console.log(`[shadow] pruned ${removed.length} host or unreachable packages`)
    }

    const stage = path.join(work, "stage")
    await mkdir(stage, { recursive: true })
    await runCommand(["tar", "-xzf", unicorn.file, "--strip-components=1", "-C", stage], { cwd: work })
    await rename(path.join(install, "node_modules"), path.join(stage, "node_modules"))
    await rm(path.join(stage, "node_modules", PLUGIN), { recursive: true, force: true })
    await rm(path.join(stage, "node_modules", ".package-lock.json"), { force: true })

    const snapshot = {
      format: 1,
      installedAt: new Date().toISOString(),
      repository,
      commit: await git(["rev-parse", "HEAD"]),
      dirty: Boolean(await git(["status", "--porcelain"])),
      mode: full ? "full" : "pruned",
      versions: Object.fromEntries(packages.map((item) => [item.manifest.name, item.manifest.version])),
    }
    await writeJSON(path.join(stage, SNAPSHOT), snapshot)
    await validate(stage, packages, { full })

    const previous = path.join(parent, `.${path.basename(directory)}.previous-${randomUUID()}`)
    const hadPrevious = await exists(directory)
    if (hadPrevious) await rename(directory, previous)
    try {
      await rename(stage, directory)
    } catch (error) {
      if (hadPrevious) await rename(previous, directory)
      throw error
    }
    if (hadPrevious) await rm(previous, { recursive: true, force: true }).catch(() => {})
    return snapshot
  } finally {
    await rm(work, { recursive: true, force: true })
  }
}

function captureCommand(args, { cwd, env, timeout = 30_000 }) {
  return new Promise((resolve, reject) => {
    const child = spawn(args[0], args.slice(1), { cwd, env, stdio: ["ignore", "pipe", "pipe"] })
    let output = ""
    const timer = setTimeout(() => child.kill("SIGKILL"), timeout)
    child.stdout.setEncoding("utf8").on("data", (data) => { output += data })
    child.stderr.setEncoding("utf8").on("data", (data) => { output += data })
    child.once("error", (error) => { clearTimeout(timer); reject(error) })
    child.once("close", (code) => { clearTimeout(timer); resolve({ code, output }) })
  })
}

async function verify(directory) {
  assertTarget(directory)
  if (!(await exists(path.join(directory, SNAPSHOT)))) throw new Error(`No snapshot at ${directory}; run shadow:update first`)
  const work = await mkdtemp(path.join(os.tmpdir(), "opencode-shadow-verify-"))
  try {
    const config = path.join(work, "config")
    const cwd = path.join(work, "work")
    await mkdir(config, { recursive: true })
    await mkdir(cwd, { recursive: true })
    await writeJSON(path.join(config, "opencode.json"), {
      plugins: [{ package: pathToFileURL(directory).href }],
    })
    const { code, output } = await captureCommand(["opencode", "debug", "agents", "--standalone", "--print-logs"], {
      cwd,
      env: { ...process.env, OPENCODE_CONFIG_DIR: config },
    })
    if (code !== 0) throw new Error(`OpenCode exited with ${code}\n${output.slice(-2000)}`)
    const identities = [directory]
    try { identities.push(await realpath(directory)) } catch {}
    if (!output.includes("loading plugin") || !identities.some((identity) => output.includes(identity))) {
      throw new Error(`OpenCode did not load the shadow plugin\n${output.slice(-2000)}`)
    }
    if (/Cannot find module|is not provided by OpenCode/.test(output)) throw new Error(output.slice(-2000))
    console.log(`[shadow] OpenCode loaded ${directory}`)
  } finally {
    await rm(work, { recursive: true, force: true })
  }
}

async function status(directory) {
  const config = pathToFileURL(directory).href
  if (!(await exists(path.join(directory, SNAPSHOT)))) {
    console.log(`[shadow] not installed: ${directory}`)
    console.log(`[shadow] run: npm run shadow:update`)
    console.log(`[shadow] OpenCode plugin path: ${config}`)
    return 1
  }
  const snapshot = await readJSON(path.join(directory, SNAPSHOT))
  const manifest = await readJSON(path.join(directory, "package.json"))
  const packages = await workspacePackages(repository)
  let missingPackages = 0
  for (const item of packages) {
    if (item.manifest.name === PLUGIN) continue
    const installed = await readJSON(path.join(directory, "node_modules", item.manifest.name, "package.json")).catch(() => undefined)
    if (installed?.version !== item.manifest.version) {
      missingPackages++
      console.log(`[shadow] stale ${item.manifest.name}: ${installed?.version ?? "missing"} != ${item.manifest.version}`)
    }
  }
  let unexpected = 0
  if ((snapshot.mode ?? "full") !== "full") {
    for (const name of PRUNED_MODULES) {
      if (!(await exists(path.join(directory, "node_modules", name)))) continue
      unexpected++
      console.log(`[shadow] unexpected pruned dependency: ${name}`)
    }
  }
  console.log(`[shadow] path ${directory}`)
  console.log(`[shadow] version ${manifest.version}`)
  console.log(`[shadow] mode ${snapshot.mode ?? "full"}`)
  console.log(`[shadow] installed ${snapshot.installedAt}`)
  console.log(`[shadow] commit ${snapshot.commit.slice(0, 12)}${snapshot.dirty ? " (dirty)" : ""}`)
  console.log(`[shadow] packages ${packages.length - missingPackages}/${packages.length}${missingPackages || unexpected ? " (run shadow:update)" : ""}`)
  console.log(`[shadow] OpenCode plugin path: ${config}`)
  return missingPackages || unexpected ? 1 : 0
}

async function clean(directory) {
  assertTarget(directory)
  if (await exists(directory) && !(await exists(path.join(directory, SNAPSHOT)))) {
    throw new Error(`Refusing to remove ${directory}: ${SNAPSHOT} is missing`)
  }
  const parent = path.dirname(directory)
  const base = path.basename(directory)
  const entries = await readdir(parent).catch(() => [])
  let removed = 0
  for (const entry of entries) {
    if (entry !== base && !entry.startsWith(`.${base}.work-`) && !entry.startsWith(`.${base}.previous-`)) continue
    await rm(path.join(parent, entry), { recursive: true, force: true })
    removed++
  }
  console.log(removed ? `[shadow] removed ${removed} director${removed === 1 ? "y" : "ies"} under ${parent}` : `[shadow] nothing to remove under ${parent}`)
}

async function main() {
  const { command, directory, full } = parse(process.argv.slice(2))
  if (command === "help" || command === "--help" || command === "-h") return usage()
  if (command === "update") {
    const snapshot = await update(directory, { full })
    console.log(`[shadow] installed ${PLUGIN}@${snapshot.versions[PLUGIN]}`)
    console.log(`[shadow] path ${directory}`)
    console.log(`[shadow] OpenCode plugin path: ${pathToFileURL(directory).href}`)
    console.log("[shadow] restart OpenCode to load the new snapshot")
    return
  }
  if (command === "status") {
    process.exitCode = await status(directory)
    return
  }
  if (command === "verify") return verify(directory)
  if (command === "clean") return clean(directory)
  throw new Error(`Unknown command: ${command}`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`[shadow] ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  })
}
