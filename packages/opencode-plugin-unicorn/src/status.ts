import { execFile } from "node:child_process"
import { access, readFile, realpath } from "node:fs/promises"
import path from "node:path"
import { promisify } from "node:util"
import { fileURLToPath } from "node:url"

const run = promisify(execFile)
const PACKAGE_NAME = "@max10240/opencode-plugin-unicorn"

export type UnicornRuntimeStatus = {
  readonly version: string
  readonly packagePath: string
  readonly shadow: boolean
  readonly repo?: string
  readonly commit?: string
  readonly dirty?: boolean
}

export async function unicornRuntimeStatus(): Promise<UnicornRuntimeStatus> {
  const loaded = await loadedPackage()
  const packagePath = await realpath(loaded.directory).catch(() => loaded.directory)
  const shadow = packagePath.split(path.sep).includes("unicorn-shadow")
  const repo = await findRepo(packagePath)
  const commit = repo ? await git(repo, ["rev-parse", "--short", "HEAD"]) : undefined
  const dirty = repo ? Boolean((await git(repo, ["status", "--porcelain"]))?.trim()) : undefined
  return {
    version: loaded.version,
    packagePath,
    shadow,
    ...(repo === undefined ? {} : { repo }),
    ...(commit ? { commit } : {}),
    ...(dirty === undefined ? {} : { dirty }),
  }
}

async function loadedPackage() {
  const here = path.dirname(fileURLToPath(import.meta.url))
  for (const candidate of [path.resolve(here, ".."), path.resolve(here, "..", ".."), path.resolve(here, "..", "..", "..")]) {
    try {
      const manifest = JSON.parse(await readFile(path.join(candidate, "package.json"), "utf8")) as { name?: unknown; version?: unknown }
      if (manifest.name === PACKAGE_NAME && typeof manifest.version === "string") {
        return { directory: candidate, version: manifest.version }
      }
    } catch {
      // Try the next layout: source, dist/src, or a symlinked package root.
    }
  }
  return { directory: path.resolve(here, ".."), version: "unknown" }
}

async function findRepo(from: string) {
  let current = from
  for (let depth = 0; depth < 8; depth++) {
    try {
      await access(path.join(current, ".git"))
      return current
    } catch {
      const parent = path.dirname(current)
      if (parent === current) break
      current = parent
    }
  }
  return undefined
}

async function git(cwd: string, args: readonly string[]) {
  try {
    const result = await run("git", args, { cwd, encoding: "utf8" })
    return result.stdout
  } catch {
    return undefined
  }
}
