import { randomUUID } from "node:crypto"
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { parse } from "jsonc-parser"

export const commandsTemplate = fileURLToPath(new URL("../packages/opencode-plugin-recomended-opencode-config/rules/commands.json", import.meta.url))
const fields = { template: "string", description: "string", agent: "string", model: "string", subagent: "boolean", subtask: "boolean" }

export function extractCommands(text) {
  const errors = []
  const document = parse(text, errors, { allowTrailingComma: true })
  if (errors.length || !document || typeof document !== "object" || Array.isArray(document)) throw new Error("Invalid commands source JSONC")
  const commands = Object.hasOwn(document, "commands") ? document.commands : {}
  if (typeof commands !== "object" || commands === null || Array.isArray(commands)) throw new Error("Inline commands must be an object")
  return Object.fromEntries(Object.entries(commands).map(([name, command]) => {
    if (!command || typeof command !== "object" || !Object.hasOwn(command, "template") || typeof command.template !== "string") throw new Error(`Command ${name} requires a template`)
    const entries = Object.entries(fields).filter(([field]) => Object.hasOwn(command, field)).map(([field, type]) => {
      if (typeof command[field] !== type) throw new Error(`Invalid ${field} for command ${name}`)
      return [field, command[field]]
    })
    return [name, Object.fromEntries(entries)]
  }))
}

export async function syncRecommendedCommands({ source = process.env.RECOMMENDED_COMMANDS_SOURCE ?? path.join(os.homedir(), ".config/opencode/opencode.jsonc"), target = commandsTemplate } = {}) {
  let text
  try { text = await readFile(source, "utf8") } catch (error) {
    if (error.code !== "ENOENT") throw error
    if (await readFile(target, "utf8").catch(() => undefined) !== undefined) return false
    text = "{}"
  }
  const content = `${JSON.stringify(extractCommands(text), null, 2)}\n`
  if (await readFile(target, "utf8").catch(() => undefined) === content) return false
  await mkdir(path.dirname(target), { recursive: true })
  const temporary = `${target}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, content, { flag: "wx" })
    await rename(temporary, target)
  } finally { await unlink(temporary).catch((error) => { if (error.code !== "ENOENT") throw error }) }
  return true
}
