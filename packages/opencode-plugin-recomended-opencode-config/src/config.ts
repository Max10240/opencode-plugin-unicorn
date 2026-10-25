import { applyEdits, findNodeAtLocation, modify, parse, parseTree, type Edit, type Node, type ParseError } from "jsonc-parser"
import { randomUUID } from "node:crypto"
import { chmod, lstat, lutimes, mkdir, readFile, realpath, rename, stat, unlink, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { mergeRules, type RecommendedRule } from "./rules.js"
import { existingMarkdownCommands, type RecommendedCommands } from "./commands.js"

export function globalConfigDirectory(environment: NodeJS.ProcessEnv = process.env, home = os.homedir()) {
  return path.resolve(environment.OPENCODE_CONFIG_DIR || path.join(environment.XDG_CONFIG_HOME || path.join(home, ".config"), "opencode"))
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
export function updateOpenAIStore(markdown: string): string {
  const errors: ParseError[] = []
  const document: unknown = parse(markdown, errors, { allowTrailingComma: true })
  if (errors.length || !object(document)) throw new Error("Cannot update invalid OpenCode JSONC")
  if (!Object.hasOwn(document, "providers") || !object(document.providers) || !Object.hasOwn(document.providers, "openai") || !object(document.providers.openai)) return markdown
  const provider = document.providers.openai
  const settings = Object.hasOwn(provider, "settings") ? provider.settings : undefined
  if (settings !== undefined && !object(settings)) throw new Error("OpenAI settings must be an object")
  if (object(settings) && Object.hasOwn(settings, "store") && settings.store === false) return markdown
  return applyEdits(markdown, modify(markdown, ["providers", "openai", "settings", "store"], false, {
    formattingOptions: { tabSize: 2, insertSpaces: true, eol: markdown.includes("\r\n") ? "\r\n" : "\n" },
  }))
}

// Keep Markdown's config-like text literal when serializing it into JSONC.
function preserveCommandLiterals(text: string, name: string) {
  const root = parseTree(text, undefined, { allowTrailingComma: true })
  const command = root && findNodeAtLocation(root, ["commands", name])
  const key = command?.parent?.children?.[0]
  if (!command || !key) throw new Error(`Cannot locate recommended command: ${name}`)
  const edits: Edit[] = []
  const visit = (node: Node) => {
    if (node.type === "string") {
      const original = text.slice(node.offset, node.offset + node.length)
      const content = original.replaceAll("{", "\\u007b")
      if (content !== original) edits.push({ offset: node.offset, length: node.length, content })
    }
    for (const child of node.children ?? []) visit(child)
  }
  visit(key)
  visit(command)
  return applyEdits(text, edits)
}

export function updateConfigText(text: string, commands: RecommendedCommands = {}, existingCommands: ReadonlySet<string> = new Set(), markdownCommands: ReadonlySet<string> = new Set()) {
  let updated = updateOpenAIStore(text)
  const document = parse(text) as Record<string, unknown>
  if (Object.hasOwn(document, "commands") && !object(document.commands)) throw new Error("OpenCode commands must be an object")
  const current = Object.hasOwn(document, "commands") && object(document.commands) ? document.commands : {}
  for (const [name, command] of Object.entries(commands)) {
    if (existingCommands.has(name) || Object.hasOwn(current, name)) continue
    updated = applyEdits(updated, modify(updated, ["commands", name], command, {
      formattingOptions: { tabSize: 2, insertSpaces: true, eol: text.includes("\r\n") ? "\r\n" : "\n" },
    }))
    if (markdownCommands.has(name)) updated = preserveCommandLiterals(updated, name)
  }
  return updated
}

async function read(file: string): Promise<string | undefined> {
  try { return await readFile(file, "utf8") } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return
    throw error
  }
}

export async function atomicUpdate(
  file: string,
  transform: (text: string, exists: boolean) => string | Promise<string>,
  create = false,
  validate?: () => Promise<boolean>,
) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const target = await resolveFile(file)
    const original = await read(target)
    if (original === undefined && !create) return false
    const updated = await transform(original ?? "", original !== undefined)
    if (updated === (original ?? "")) return false
    const mode = await stat(target).then((info) => info.mode & 0o777, (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return 0o600
      throw error
    })
    await mkdir(path.dirname(target), { recursive: true })
    const temporary = path.join(path.dirname(target), `.${path.basename(target)}.${randomUUID()}.tmp`)
    try {
      await writeFile(temporary, updated, { flag: "wx", mode })
      await chmod(temporary, mode)
      if (validate && !await validate()) continue
      if (await resolveFile(file) !== target || await read(file) !== original) continue
      await rename(temporary, target)
      // OpenCode watches the config directory; notify it without replacing a dotfile symlink.
      if ((await lstat(file)).isSymbolicLink()) {
        const now = new Date()
        await lutimes(file, now, now)
      }
      return true
    } finally { await unlink(temporary).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error }) }
  }
  throw new Error("OpenCode configuration changed concurrently; update skipped")
}

async function resolveFile(file: string) {
  try { return await realpath(file) } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    const info = await lstat(file).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined
      throw error
    })
    if (info?.isSymbolicLink()) throw new Error("Cannot update a dangling configuration symlink")
    return path.resolve(file)
  }
}

const locks = new Map<string, Promise<unknown>>()
async function commandState(directory: string, files: readonly string[]) {
  const markdown = await existingMarkdownCommands(directory)
  const names = new Set(markdown)
  const documents = new Map<string, string | undefined>()
  for (const file of files) {
    const text = await read(file)
    documents.set(file, text)
    if (text !== undefined) {
      updateConfigText(text)
      const document = parse(text) as { commands?: Record<string, unknown> }
      for (const name of Object.keys(Object.hasOwn(document, "commands") ? document.commands ?? {} : {})) names.add(name)
    }
  }
  return { names, markdown, documents }
}

export async function applyRecommendedConfig(directory: string, rules: readonly RecommendedRule[], commands: RecommendedCommands = {}, markdownCommands: ReadonlySet<string> = new Set()) {
  directory = path.resolve(directory)
  directory = await realpath(directory).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return directory
    throw error
  })
  const previous = locks.get(directory) ?? Promise.resolve()
  const task = previous.catch(() => {}).then(async () => {
    // Validate every existing JSON document before writing either kind of file.
    const configs = ["opencode.json", "opencode.jsonc"].map((name) => path.join(directory, name))
    const present: string[] = []
    const existingCommands = await existingMarkdownCommands(directory)
    for (const file of configs) {
      const text = await read(file)
      if (text !== undefined) {
        updateConfigText(text)
        present.push(file)
        const document = parse(text) as { commands?: Record<string, unknown> }
        for (const name of Object.keys(Object.hasOwn(document, "commands") ? document.commands ?? {} : {})) existingCommands.add(name)
      }
    }
    const commandTarget = present.at(-1) ?? configs[1]
    const missing = Object.fromEntries(Object.entries(commands).filter(([name]) => !existingCommands.has(name)))
    let rulesChanged = false
    try {
      rulesChanged = await atomicUpdate(path.join(directory, "AGENTS.md"), (text) => mergeRules(text, rules), true)
    } catch (error) {
      console.warn(`Recommended rules update skipped: ${error instanceof Error ? error.message : "unknown error"}`)
    }
    const configChanged: string[] = []
    const writes = present.includes(commandTarget) || !Object.keys(missing).length ? present : [...present, commandTarget]
    for (const file of writes) {
      if (file !== commandTarget) {
        if (await atomicUpdate(file, updateOpenAIStore)) configChanged.push(file)
        continue
      }
      let state: Awaited<ReturnType<typeof commandState>> | undefined
      const changed = await atomicUpdate(file, async (text, exists) => {
        state = await commandState(directory, configs.filter((candidate) => candidate !== file))
        return updateConfigText(exists ? text : "{}\n", commands, state.names, markdownCommands)
      }, Object.keys(missing).length > 0, async () => {
        if (!state) return false
        for (const [file, original] of state.documents) if (await read(file) !== original) return false
        const current = await existingMarkdownCommands(directory)
        return current.size === state.markdown.size && [...current].every((name) => state!.markdown.has(name))
      })
      if (changed) configChanged.push(file)
    }
    return { rulesChanged, configChanged }
  })
  locks.set(directory, task)
  try { return await task } finally { if (locks.get(directory) === task) locks.delete(directory) }
}
