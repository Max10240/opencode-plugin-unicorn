import { createHash } from "node:crypto"
import { readdir, readFile, realpath, stat } from "node:fs/promises"
import path from "node:path"

export const BUILD_MANIFEST = "UNICORN_TEST_BUILD_MANIFEST"

export async function workspacePackages(root) {
  const entries = await readdir(path.join(root, "packages"), { withFileTypes: true })
  const packages = []
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory()) continue
    const directory = path.join(root, "packages", entry.name)
    const manifest = JSON.parse(await readFile(path.join(directory, "package.json"), "utf8"))
    packages.push({ directory, manifest })
  }
  return packages
}

export function buildLevels(packages) {
  const remaining = new Map(packages.map((item) => [item.manifest.name, item]))
  if (remaining.size !== packages.length) throw new Error("Duplicate workspace package name")
  const levels = []
  while (remaining.size) {
    const ready = [...remaining.values()].filter(({ manifest }) =>
      Object.keys({ ...manifest.dependencies, ...manifest.optionalDependencies }).every((name) => !remaining.has(name)),
    )
    if (!ready.length) throw new Error("Workspace build dependency cycle")
    levels.push(ready)
    for (const item of ready) remaining.delete(item.manifest.name)
  }
  return levels
}

export async function mapLimit(items, limit, run) {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("Concurrency must be a positive integer")
  const results = new Array(items.length)
  let next = 0
  let failure
  let failed = false
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (!failed && next < items.length) {
      const index = next++
      try { results[index] = await run(items[index], index) } catch (error) { if (!failed) { failed = true; failure = error } }
    }
  }))
  if (failed) throw failure
  return results
}

export async function treeFiles(directory, excluded = new Set()) {
  const result = []
  async function visit(current, ancestors = new Set()) {
    const target = await realpath(current)
    if (ancestors.has(target)) throw new Error(`Directory symlink cycle: ${current}`)
    const parents = new Set([...ancestors, target])
    for (const entry of (await readdir(current, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if (excluded.has(entry.name)) continue
      const file = path.join(current, entry.name)
      const info = entry.isSymbolicLink() ? await stat(file) : entry
      if (info.isDirectory()) await visit(file, parents)
      else if (info.isFile()) result.push(file)
    }
  }
  await visit(directory)
  return result
}

export async function buildFingerprint(root, overrides = new Map()) {
  const inputs = [path.join(root, "package.json")]
  for (const directory of ["packages", "scripts", "test"]) {
    inputs.push(...await treeFiles(path.join(root, directory), new Set(["node_modules", "dist", "coverage"])))
  }
  for (const name of ["bun.lock", "package-lock.json"]) {
    try { await readFile(path.join(root, name)); inputs.push(path.join(root, name)) } catch (error) { if (error.code !== "ENOENT") throw error }
  }
  const outputs = []
  for (const item of await workspacePackages(root)) {
    const files = await treeFiles(path.join(item.directory, "dist"))
    if (!files.some((file) => file.endsWith(".js"))) throw new Error(`Build output missing: ${item.manifest.name}`)
    outputs.push(...files)
  }
  const hash = createHash("sha256")
  for (const [kind, files] of [["input", inputs], ["output", outputs]]) {
    for (const file of files.sort()) hash.update(JSON.stringify([kind, path.relative(root, file), (overrides.has(file) ? overrides.get(file) : await readFile(file)).toString("base64")]))
  }
  return hash.digest("hex")
}
