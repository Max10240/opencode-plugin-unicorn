import { parse } from "jsonc-parser"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { existingMarkdownCommands } from "./commands.js"
import { globalConfigDirectory } from "./config.js"
import { parseRules } from "./rules.js"
import { recommendedCommands, recommendedRules } from "./snapshot.js"

export type RecommendedStatus = {
  readonly directory: string
  readonly configFiles: readonly string[]
  readonly enabled: boolean
  readonly rules: { readonly total: number; readonly present: number; readonly missing: readonly string[] }
  readonly commands: { readonly total: number; readonly present: readonly string[]; readonly missing: readonly string[] }
}

export async function recommendedStatus(directory = globalConfigDirectory(), enabled = false): Promise<RecommendedStatus> {
  const configFiles = (await Promise.all(["opencode.json", "opencode.jsonc"].map(async (name) => {
    const file = path.join(directory, name)
    try {
      await readFile(file, "utf8")
      return file
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return
      throw error
    }
  }))).filter((file): file is string => Boolean(file))

  const commandNames = new Set(await existingMarkdownCommands(directory))
  for (const file of configFiles) {
    const text = await readFile(file, "utf8").catch(() => undefined)
    if (text === undefined) continue
    const document = parse(text) as { commands?: Record<string, unknown> } | undefined
    for (const name of Object.keys(document?.commands ?? {})) commandNames.add(name)
  }

  const agents = await readFile(path.join(directory, "AGENTS.md"), "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined
    throw error
  })
  const presentRules = new Set([
    ...(agents ? allHeadings(agents) : []),
  ])
  const ruleMissing = recommendedRules.filter((rule) => !presentRules.has(normalize(rule.title))).map((rule) => rule.title)
  const commandMissing = Object.keys(recommendedCommands).filter((name) => !commandNames.has(name))
  return {
    directory,
    configFiles,
    enabled,
    rules: { total: recommendedRules.length, present: recommendedRules.length - ruleMissing.length, missing: ruleMissing },
    commands: {
      total: Object.keys(recommendedCommands).length,
      present: Object.keys(recommendedCommands).filter((name) => commandNames.has(name)),
      missing: commandMissing,
    },
  }
}

function allHeadings(markdown: string) {
  return parseRules(markdown).map((rule) => normalize(rule.title))
}

function normalize(value: string) {
  return value.trim().replace(/\s+/g, " ")
}
