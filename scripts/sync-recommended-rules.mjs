import { randomUUID } from "node:crypto"
import { link, lstat, mkdir, realpath, rename, stat, unlink } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { syncRecommendedCommands } from "./sync-recommended-commands.mjs"

export const rulesTemplate = fileURLToPath(new URL("../packages/opencode-plugin-recomended-opencode-config/rules/AGENTS.md", import.meta.url))
export async function syncRecommendedRules({ source = process.env.RECOMMENDED_RULES_SOURCE ?? path.join(os.homedir(), ".config/opencode/AGENTS.md"), target = rulesTemplate } = {}) {
  const original = await stat(source).catch((error) => {
    if (error.code === "ENOENT") return undefined
    throw error
  })
  if (!original) {
    if (await stat(target).catch(() => undefined)) return false
    throw new Error("Recommended rules source and template are both missing")
  }
  if (!original.isFile()) throw new Error("Recommended rules source must be a regular file")
  const current = await lstat(target).catch(() => undefined)
  if (current?.dev === original.dev && current?.ino === original.ino) return false
  await mkdir(path.dirname(target), { recursive: true })
  const temporary = `${target}.${randomUUID()}.link`
  try {
    await link(await realpath(source), temporary)
    await rename(temporary, target)
  } finally { await unlink(temporary).catch((error) => { if (error.code !== "ENOENT") throw error }) }
  return true
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await syncRecommendedCommands()
  await syncRecommendedRules()
}
