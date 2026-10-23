import { readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { applyEdits, modify } from "jsonc-parser"
import { assertPluginVersions } from "./check-versions.mjs"
import { workspacePackages } from "./workspace.mjs"

const repository = fileURLToPath(new URL("../", import.meta.url))

export async function syncPluginDependencies(root = repository) {
  const packages = await workspacePackages(root)
  const result = assertPluginVersions(packages.map((item) => item.manifest), { dependencies: false })
  const names = new Set(packages.filter(({ manifest }) => manifest.private !== true && manifest.name?.startsWith("@max10240/opencode-plugin-")).map(({ manifest }) => manifest.name))
  for (const item of packages) {
    if (!names.has(item.manifest.name)) continue
    const file = path.join(item.directory, "package.json")
    const original = await readFile(file, "utf8")
    let content = original
    for (const field of ["dependencies", "optionalDependencies"]) {
      for (const name of Object.keys(item.manifest[field] ?? {})) {
        if (names.has(name)) content = applyEdits(content, modify(content, [field, name], result.version, {}))
      }
    }
    if (content !== original) await writeFile(file, content)
  }
  return result
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { const result = await syncPluginDependencies(); console.log(`Plugin dependencies pinned to ${result.version}`) }
  catch (error) { console.error(error.message); process.exitCode = 1 }
}
