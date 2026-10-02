import { readdir, readFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

const repository = fileURLToPath(new URL("../", import.meta.url))

export function assertPluginVersions(packages) {
  const plugins = packages.filter((entry) => entry.private !== true && typeof entry.name === "string" && entry.name.startsWith("@max10240/opencode-plugin-"))
  const unicorn = plugins.find((entry) => entry.name === "@max10240/opencode-plugin-unicorn")
  if (!unicorn || typeof unicorn.version !== "string" || !unicorn.version) {
    throw new Error("Unicorn must define the shared plugin version")
  }
  const mismatches = plugins.filter((entry) => entry.version !== unicorn.version)
  if (mismatches.length) {
    throw new Error(`Plugin versions must all be ${unicorn.version}: ${mismatches.map((entry) => `${entry.name}=${entry.version ?? "missing"}`).join(", ")}`)
  }
  return { version: unicorn.version, count: plugins.length }
}

export async function checkPluginVersions(root = repository) {
  const directory = path.join(root, "packages")
  const entries = await readdir(directory, { withFileTypes: true })
  const manifests = await Promise.all(entries.filter((entry) => entry.isDirectory() || entry.isSymbolicLink()).map(async (entry) => {
    const file = path.join(directory, entry.name, "package.json")
    try {
      return JSON.parse(await readFile(file, "utf8"))
    } catch (error) {
      if (error.code === "ENOENT") return {}
      throw error
    }
  }))
  return assertPluginVersions(manifests)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await checkPluginVersions()
    console.log(`Plugin versions aligned: ${result.count} packages at ${result.version}`)
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
