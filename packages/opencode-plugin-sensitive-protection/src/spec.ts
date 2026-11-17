import { JSONPath } from "jsonpath-plus"
import { parse as parseIni } from "ini"
import { parse as parseToml } from "smol-toml"
import { parse as parseYaml } from "yaml"

export type StructuredFormat = "json" | "yaml" | "ini" | "toml"
export type ExtractFormat = StructuredFormat | "private-key" | "line" | "netrc" | "git-credentials"

export type FileSpec = {
  readonly path: string
  readonly format: ExtractFormat
  readonly keys: readonly string[]
}

export type ExtractedValue = {
  readonly value: string
  readonly key: string
}

export type ExtractResult = {
  readonly values: ExtractedValue[]
  readonly available: string[]
  readonly missing: string[]
}

export type ExtractOptions = {
  /** Require every selector to match. Defaults are lenient and are skipped when nothing matches. */
  readonly strict?: boolean
}

const MIN_SECRET_LENGTH = 6
const MAX_PATTERN_LENGTH = 1024 * 1024
const MAX_SELECTOR_LENGTH = 1024

export const STRUCTURED_FORMATS: readonly StructuredFormat[] = ["json", "yaml", "ini", "toml"]

export const EXTRACT_FORMATS: readonly ExtractFormat[] = [
  ...STRUCTURED_FORMATS,
  "private-key",
  "line",
  "netrc",
  "git-credentials",
]

export function isStructuredFormat(value: string): value is StructuredFormat {
  return value === "json" || value === "yaml" || value === "ini" || value === "toml"
}

export function isExtractFormat(value: unknown): value is ExtractFormat {
  return typeof value === "string" && (EXTRACT_FORMATS as readonly string[]).includes(value)
}

export function parseStructured(content: string, format: StructuredFormat): unknown {
  switch (format) {
    case "json":
      return JSON.parse(content)
    case "yaml":
      return parseYaml(content)
    case "ini":
      return parseIni(content)
    case "toml":
      return parseToml(content)
  }
}

export function detectFormat(path: string, content: string): ExtractFormat | undefined {
  const extension = path.toLowerCase().split(".").pop()
  if (extension === "json") return "json"
  if (extension === "yaml" || extension === "yml") return "yaml"
  if (extension === "toml") return "toml"
  if (extension === "ini" || extension === "env" || extension === "conf" || extension === "cfg") return "ini"
  if (isPrivateKey(content)) return "private-key"
  if (nonEmptyLines(content).length === 1) return "line"
  const trimmed = content.trim()
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      JSON.parse(trimmed)
      return "json"
    } catch {}
  }
  if (trimmed.startsWith("---") || /^[A-Za-z0-9_.-]+:\s/m.test(trimmed)) {
    try {
      parseYaml(trimmed)
      return "yaml"
    } catch {}
  }
  if (/^\s*\[[^\]]+\]\s*$/m.test(trimmed) && /=/.test(trimmed)) {
    try {
      parseIni(trimmed)
      return "ini"
    } catch {}
  }
  if (/^\s*\[[^\]]+\]\s*$/m.test(trimmed) && /=/.test(trimmed)) {
    try {
      parseToml(trimmed)
      return "toml"
    } catch {}
  }
  return
}

export function extractContent(
  content: string,
  format: ExtractFormat,
  selectors: readonly string[],
  options: ExtractOptions = {},
): ExtractResult {
  if (format === "private-key") {
    const values = privateKeyValues(content)
    return validate(values, ["private key"], [])
  }
  if (format === "line") {
    const lines = nonEmptyLines(content)
    if (lines.length !== 1) {
      return { values: [], available: ["line"], missing: ["line"] }
    }
    const value = lines[0]!.trim()
    return { values: value ? [{ value, key: "line" }] : [], available: ["line"], missing: value ? [] : ["line"] }
  }
  if (selectors.length === 0) {
    if (format === "netrc") return { values: [], available: availablePaths(parseNetrc(content)), missing: [] }
    if (format === "git-credentials") return { values: [], available: availablePaths(parseGitCredentials(content)), missing: [] }
    const data = parseStructured(content, format)
    assertAcyclic(data)
    return { values: [], available: availablePaths(data), missing: [] }
  }
  if (format === "netrc") return select(content, parseNetrc(content), selectors, options)
  if (format === "git-credentials") return select(content, parseGitCredentials(content), selectors, options)
  const data = parseStructured(content, format)
  assertAcyclic(data)
  return select(content, data, selectors, options)
}

export function select(
  _content: string,
  data: unknown,
  selectors: readonly string[],
  options: ExtractOptions = {},
): ExtractResult {
  const available = availablePaths(data)
  const values: ExtractedValue[] = []
  const missing: string[] = []
  const seen = new Set<string>()
  for (const selector of selectors) {
    const query = toJsonPath(selector)
    const results = JSONPath({ path: query, json: data as object, resultType: "all", wrap: true, eval: "safe" }) as Array<{
      value?: unknown
      path?: string
    }>
    let matched = 0
    for (const result of results) {
      for (const value of stringValues(result.value)) {
        if (!value || value.length < MIN_SECRET_LENGTH || value.length > MAX_PATTERN_LENGTH) continue
        if (looksLikePlaceholder(value)) continue
        matched++
        const identity = `${selector}\u0000${value}`
        if (seen.has(identity)) continue
        seen.add(identity)
        values.push({ value, key: selector })
      }
    }
    if (matched === 0) missing.push(selector)
  }
  if (options.strict === true && missing.length > 0) {
    return { values, available, missing }
  }
  return { values, available, missing }
}

export function patternsForValues(values: readonly (string | ExtractedValue)[]) {
  const patterns = new Map<string, { value: string; key?: string }>()
  const add = (value: string, key: string | undefined) => {
    if (!value || value.length < MIN_SECRET_LENGTH || value.length > MAX_PATTERN_LENGTH) return
    if (looksLikePlaceholder(value)) return
    if (!patterns.has(value)) patterns.set(value, key === undefined ? { value } : { value, key })
  }
  for (const item of values) {
    const raw = typeof item === "string" ? item : item.value
    const key = typeof item === "string" ? undefined : item.key
    const clean = raw.trim()
    if (!clean) continue
    add(clean, key)
    const escaped = JSON.stringify(clean).slice(1, -1)
    if (escaped !== clean) add(escaped, key)
    if (clean.length <= 1024) {
      add(Buffer.from(clean).toString("base64"), key)
      add(Buffer.from(clean).toString("base64url"), key)
    }
  }
  return [...patterns.values()].sort((left, right) => right.value.length - left.value.length)
}

export function availablePaths(value: unknown): string[] {
  const result: string[] = []
  const seen = new Set<unknown>()
  const walk = (item: unknown, path: string) => {
    if (typeof item === "string") {
      if (item.length > 0) result.push(path || "$")
      return
    }
    if (!item || typeof item !== "object") return
    if (seen.has(item)) return
    seen.add(item)
    if (Array.isArray(item)) {
      item.forEach((child, index) => walk(child, path ? `${path}[${index}]` : `[${index}]`))
      return
    }
    for (const [key, child] of Object.entries(item)) {
      const next = path ? `${path}.${displayKey(key)}` : displayKey(key)
      walk(child, next)
    }
  }
  walk(value, "")
  return result
}

export function validateValues(result: ExtractResult, selectors: readonly string[]): ExtractResult {
  const missing = selectors.filter((selector) => result.missing.includes(selector))
  return { ...result, missing }
}

function validate(values: ExtractedValue[], available: string[], missing: string[]): ExtractResult {
  if (values.length === 0 && missing.length === 0) missing = available
  return { values, available, missing }
}

function stringValues(value: unknown): string[] {
  if (typeof value === "string") return [value]
  if (Array.isArray(value)) return value.flatMap(stringValues)
  return []
}

export function nonEmptyLines(content: string) {
  return content.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
}

export function isPrivateKey(content: string) {
  return /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----|---- BEGIN SSH2 ENCRYPTED PRIVATE KEY ----/.test(content)
}

export function privateKeyValues(content: string): ExtractedValue[] {
  const lines = content.split(/\r?\n/)
  const values: ExtractedValue[] = []
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!.trim()
    if (!/^-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----$/.test(line) && line !== "---- BEGIN SSH2 ENCRYPTED PRIVATE KEY ----") {
      continue
    }
    let end = index + 1
    while (end < lines.length) {
      const current = lines[end]!.trim()
      if (/^-----END [A-Z0-9 ]*PRIVATE KEY-----$/.test(current) || current === "---- END SSH2 ENCRYPTED PRIVATE KEY ----") break
      end++
    }
    const bodyLines = lines
      .slice(index + 1, end)
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !/^[A-Za-z-]+:\s/.test(line))
    const body = bodyLines.join("\n")
    if (body) values.push({ value: body, key: "private key body" })
    // Read output prefixes every line with a line number, so the whole block does
    // not match there. Key body lines are high-entropy and safe to match alone.
    for (const line of bodyLines) values.push({ value: line, key: "private key line" })
    index = end
  }
  return uniqueValues(values)
}

function parseNetrc(content: string): Array<Record<string, string>> {
  const result: Array<Record<string, string>> = []
  const tokens = content.split(/\s+/).filter(Boolean)
  let current: Record<string, string> | undefined
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]!
    if (token === "machine") {
      current = { machine: tokens[++index] ?? "" }
      result.push(current)
      continue
    }
    if (token === "default") {
      current = { machine: "default" }
      result.push(current)
      continue
    }
    if (token === "macdef") {
      index++
      continue
    }
    if (!current) continue
    if (token === "login" || token === "password" || token === "account") {
      current[token] = tokens[++index] ?? ""
    }
  }
  return result
}

function parseGitCredentials(content: string): Array<Record<string, string>> {
  const result: Array<Record<string, string>> = []
  for (const line of nonEmptyLines(content)) {
    try {
      const url = new URL(line)
      result.push({
        protocol: url.protocol.replace(/:$/, ""),
        username: decodeURIComponent(url.username),
        password: decodeURIComponent(url.password),
        host: url.host,
      })
    } catch {}
  }
  return result
}

export function toJsonPath(selector: string): string {
  if (!selector || selector.length > MAX_SELECTOR_LENGTH || /[\r\n]/.test(selector)) {
    throw new Error(`Invalid key selector: ${selector}`)
  }
  if (!selector.includes(".") && !selector.includes("[") && !selector.includes("*") && !selector.includes("?")) {
    return `$..[?(@property === ${JSON.stringify(selector)})]`
  }
  if (!selector.includes(".") && !selector.includes("[") && /[*?]/.test(selector)) {
    return `$..[?(@property.match(/${globToRegExp(selector)}/))]`
  }
  const parts = selector.split(".")
  let path = "$"
  for (const part of parts) {
    const parsed = parseSegment(part)
    if (!parsed) throw new Error(`Invalid key selector: ${selector}`)
    const { base, array } = parsed
    if (base === "*") path += ".*"
    else if (base) path += `[${JSON.stringify(base)}]`
    if (array === "[]") path += "[*]"
    else if (array !== undefined) path += `[${array}]`
  }
  return path
}

function parseSegment(value: string): { base: string; array?: string } | undefined {
  if (!value) return
  if (value === "[]") return { base: "", array: "[]" }
  const match = /^(.*?)\[(.*?)\]$/.exec(value)
  if (!match) {
    if (value.includes("[") || value.includes("]")) return
    if (value.includes("*") && value !== "*") return
    return { base: value }
  }
  const base = match[1] ?? ""
  const index = match[2] ?? ""
  if (index === "" || index === "*") return { base, array: "[]" }
  if (/^\d+$/.test(index)) return { base, array: index }
  return
}

function displayKey(key: string) {
  return /^[A-Za-z_$][A-Za-z0-9_$-]*$/.test(key) ? key : JSON.stringify(key)
}

function globToRegExp(value: string) {
  let result = "^"
  for (const char of value) {
    if (char === "*") result += ".*"
    else if (char === "?") result += "."
    else if (char === "/") result += "\\/"
    else result += char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  }
  return `${result}$`
}

function looksLikePlaceholder(value: string) {
  const lower = value.toLowerCase()
  if (value.startsWith("${") && value.endsWith("}")) return true
  if (value.startsWith("$") || (value.startsWith("<") && value.endsWith(">"))) return true
  return (
    lower === "changeme" ||
    lower === "change-me" ||
    lower === "example" ||
    lower === "secret" ||
    lower === "password" ||
    lower.startsWith("your_") ||
    lower.startsWith("your-") ||
    lower.startsWith("replace-")
  )
}

function uniqueValues(values: readonly ExtractedValue[]) {
  const seen = new Set<string>()
  return values.filter((item) => {
    if (seen.has(item.value)) return false
    seen.add(item.value)
    return true
  })
}

function assertAcyclic(value: unknown) {
  const seen = new Set<unknown>()
  const walk = (item: unknown) => {
    if (!item || typeof item !== "object") return
    if (seen.has(item)) throw new Error("Cyclic structures are not supported")
    seen.add(item)
    if (Array.isArray(item)) item.forEach(walk)
    else Object.values(item).forEach(walk)
    seen.delete(item)
  }
  walk(value)
}
