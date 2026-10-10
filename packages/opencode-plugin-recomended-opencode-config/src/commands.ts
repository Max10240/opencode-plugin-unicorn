import { readdir, realpath, stat } from "node:fs/promises"
import path from "node:path"

export type RecommendedCommand = {
  readonly template: string
  readonly description?: string
  readonly agent?: string
  readonly model?: string
  readonly subagent?: boolean
  readonly subtask?: boolean
}
export type RecommendedCommands = Readonly<Record<string, RecommendedCommand>>

// Existing global Markdown commands also take precedence over recommendations.
export async function existingMarkdownCommands(directory: string): Promise<Set<string>> {
  const names = new Set<string>()
  for (const folder of ["command", "commands"]) {
    const walk = async (current: string, prefix: string, ancestors: ReadonlySet<string>) => {
      let canonical: string
      try { canonical = await realpath(current) } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return
        throw error
      }
      if (ancestors.has(canonical)) return
      if (!(await stat(canonical)).isDirectory()) return
      const next = new Set([...ancestors, canonical])
      for (const entry of await readdir(current, { withFileTypes: true })) {
        const file = path.join(current, entry.name)
        const name = prefix ? `${prefix}/${entry.name}` : entry.name
        const info = entry.isSymbolicLink() ? await stat(file).catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return undefined
          throw error
        }) : entry
        if (!info) { if (name.endsWith(".md")) names.add(name.slice(0, -3)); continue }
        if (info.isDirectory()) await walk(file, name, next)
        else if (info.isFile() && name.endsWith(".md")) names.add(name.slice(0, -3))
      }
    }
    await walk(path.join(directory, folder), "", new Set())
  }
  return names
}
