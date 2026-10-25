import { randomUUID } from "node:crypto"
import { mkdir, readFile, readdir, realpath, rename, stat, unlink, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { parse } from "jsonc-parser"
import { parseDocument } from "yaml"

export const commandsTemplate = fileURLToPath(new URL("../packages/opencode-plugin-recomended-opencode-config/rules/commands.json", import.meta.url))
const fields = { template: "string", description: "string", agent: "string", model: "string", subagent: "boolean", subtask: "boolean" }

function commandDefinition(name, command) {
  if (!command || typeof command !== "object" || Array.isArray(command) || !Object.hasOwn(command, "template") || typeof command.template !== "string") throw new Error(`Command ${name} requires a template`)
  return Object.fromEntries(Object.entries(fields).filter(([field]) => Object.hasOwn(command, field)).map(([field, type]) => {
    if (typeof command[field] !== type) throw new Error(`Invalid ${field} for command ${name}`)
    return [field, command[field]]
  }))
}

export function extractCommands(text) {
  const errors = []
  const document = parse(text, errors, { allowTrailingComma: true })
  if (errors.length || !document || typeof document !== "object" || Array.isArray(document)) throw new Error("Invalid commands source JSONC")
  const commands = Object.hasOwn(document, "commands") ? document.commands : {}
  if (typeof commands !== "object" || commands === null || Array.isArray(commands)) throw new Error("Inline commands must be an object")
  return Object.fromEntries(Object.entries(commands).map(([name, command]) => [name, commandDefinition(name, command)]))
}

function frontmatter(text) {
  const document = parseDocument(text, { merge: true })
  if (document.errors.length || document.warnings.length) throw new Error("Invalid command YAML frontmatter")
  return document.toJS({ maxAliasCount: 100 })
}

export function extractMarkdownCommand(text, name = "Markdown command") {
  text = text.replace(/^\uFEFF/, "")
  let metadata = {}
  let body = text
  if (/^---[ \t]*\r?\n/.test(text)) {
    const match = /^---[ \t]*\r?\n([\s\S]*?)^---[ \t]*(?:\r?\n|$)/m.exec(text)
    if (!match) throw new Error(`Unclosed frontmatter for command ${name}`)
    try { metadata = frontmatter(match[1]) } catch {
      // Match Core's compatibility for unquoted colons in scalar metadata.
      const sanitized = match[1].split(/\r?\n/).flatMap((line) => {
        const entry = /^([a-zA-Z_][a-zA-Z0-9_]*)\s*:\s*(.*)$/.exec(line)
        const value = entry?.[2].trim()
        if (!entry || !value || !value.includes(":") || /^[\[\]{},&*!|>'"%@`]/.test(value)) return [line]
        return [`${entry[1]}: |-`, `  ${value}`]
      }).join("\n")
      try { metadata = frontmatter(sanitized) } catch { throw new Error(`Invalid frontmatter for command ${name}`) }
    }
    if (metadata == null) metadata = {}
    if (typeof metadata !== "object" || Array.isArray(metadata)) throw new Error(`Frontmatter must be an object for command ${name}`)
    body = text.slice(match[0].length)
  }
  return commandDefinition(name, { ...metadata, template: body.trim() })
}

export async function readMarkdownCommands(directory) {
  const entries = []
  let present = false
  const walk = async (current, prefix, ancestors) => {
    let canonical
    try { canonical = await realpath(current) } catch (error) {
      if (error.code === "ENOENT" && !prefix) return
      throw error
    }
    if (ancestors.has(canonical)) return
    if (!(await stat(canonical)).isDirectory()) throw new Error(`Command directory is not a directory: ${current}`)
    present = true
    const next = new Set([...ancestors, canonical])
    for (const entry of (await readdir(current, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(current, entry.name)
      const name = prefix ? `${prefix}/${entry.name}` : entry.name
      const info = entry.isSymbolicLink() ? await stat(file).catch((error) => {
        if (error.code === "ENOENT" || error.code === "ELOOP") return undefined
        throw error
      }) : entry
      if (!info) continue
      if (info.isDirectory()) await walk(file, name, next)
      else if (info.isFile() && entry.name.endsWith(".md")) entries.push([name.slice(0, -3), extractMarkdownCommand(await readFile(file, "utf8"), name)])
    }
  }
  await walk(directory, "", new Set())
  return { present, commands: Object.fromEntries(entries) }
}

export async function syncRecommendedCommands({
  source = process.env.RECOMMENDED_COMMANDS_SOURCE ?? path.join(os.homedir(), ".config/opencode/opencode.jsonc"),
  directories = process.env.RECOMMENDED_COMMANDS_DIR ? [process.env.RECOMMENDED_COMMANDS_DIR] : [".commands", "command", "commands"].map((name) => path.join(path.dirname(source), name)),
  target = commandsTemplate,
} = {}) {
  let text
  try { text = await readFile(source, "utf8") } catch (error) {
    if (error.code !== "ENOENT") throw error
  }
  let present = text !== undefined
  const commands = new Map(Object.entries(extractCommands(text ?? "{}")))
  for (const directory of directories) {
    const markdown = await readMarkdownCommands(directory)
    present ||= markdown.present
    for (const [name, command] of Object.entries(markdown.commands)) commands.set(name, { ...command, source: "markdown" })
  }
  if (!present && await readFile(target, "utf8").catch(() => undefined) !== undefined) return false
  const content = `${JSON.stringify(Object.fromEntries(commands), null, 2)}\n`
  if (await readFile(target, "utf8").catch(() => undefined) === content) return false
  await mkdir(path.dirname(target), { recursive: true })
  const temporary = `${target}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, content, { flag: "wx" })
    await rename(temporary, target)
  } finally { await unlink(temporary).catch((error) => { if (error.code !== "ENOENT") throw error }) }
  return true
}
