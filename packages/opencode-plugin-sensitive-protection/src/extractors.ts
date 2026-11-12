import { parse as parseIni } from "ini"
import { parse as parseToml } from "smol-toml"
import { parse as parseYaml } from "yaml"
import type { ExtractFormat } from "./options.js"

export type ExtractorContext = {
  readonly file: string
  readonly home: string
  readFile(path?: string): string
  parseJson(text?: string): unknown
  parseYaml(text?: string): unknown
  parseIni(text?: string): Record<string, unknown>
  parseToml(text?: string): unknown
}

const NORMALIZED_FIELD = new Map<string, string>()
const MIN_SECRET_LENGTH = 6
const MAX_PATTERN_LENGTH = 1024 * 1024

export function normalizeKey(value: string) {
  const cached = NORMALIZED_FIELD.get(value)
  if (cached) return cached
  const normalized = value.toLowerCase().replaceAll("_", "").replaceAll("-", "")
  NORMALIZED_FIELD.set(value, normalized)
  return normalized
}

export function parseContent(format: ExtractFormat, content: string): unknown {
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

export function collectFields(value: unknown, fields: readonly string[]): string[] {
  const wanted = new Set(fields.map(normalizeKey))
  const result: string[] = []
  const seen = new Set<unknown>()
  const walk = (item: unknown) => {
    if (typeof item === "string") return
    if (!item || typeof item !== "object") return
    if (seen.has(item)) return
    seen.add(item)
    if (Array.isArray(item)) {
      for (const child of item) walk(child)
      return
    }
    for (const [key, child] of Object.entries(item)) {
      if (typeof child === "string" && wanted.has(normalizeKey(key))) result.push(child)
      else walk(child)
    }
  }
  walk(value)
  return result
}

export function extractByFormat(content: string, format: ExtractFormat, fields: readonly string[]) {
  const parsed = parseContent(format, content)
  return format === "ini" ? collectIniFields(parsed, fields) : collectFields(parsed, fields)
}

function collectIniFields(value: unknown, fields: readonly string[]): string[] {
  const wanted = new Set(fields.map(normalizeKey))
  const result: string[] = []
  const seen = new Set<unknown>()
  const walk = (item: unknown) => {
    if (!item || typeof item !== "object" || seen.has(item)) return
    seen.add(item)
    if (Array.isArray(item)) {
      for (const child of item) walk(child)
      return
    }
    for (const [key, child] of Object.entries(item)) {
      if (typeof child === "string") {
        const suffix = key.slice(key.lastIndexOf(":") + 1)
        if (wanted.has(normalizeKey(key)) || wanted.has(normalizeKey(suffix))) result.push(child)
      } else {
        walk(child)
      }
    }
  }
  walk(value)
  return result
}

export function extractNpmrc(content: string) {
  const parsed = parseIni(content)
  const result: string[] = []
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value !== "string") continue
    const suffix = key.slice(key.lastIndexOf(":") + 1)
    const normalized = normalizeKey(suffix)
    if (normalized !== "authtoken" && normalized !== "auth" && normalized !== "password") continue
    result.push(value)
    if (normalized === "auth" || normalized === "password") result.push(...decodeBase64(value))
  }
  return result
}

export function extractAwsCredentials(content: string) {
  return collectFields(parseIni(content), [
    "aws_access_key_id",
    "aws_secret_access_key",
    "aws_session_token",
  ])
}

export function extractPypirc(content: string) {
  return collectFields(parseIni(content), ["password"])
}

export function extractCargoCredentials(content: string) {
  const parsed = parseToml(content) as Record<string, unknown>
  const result: string[] = []
  const registry = parsed.registry
  if (registry && typeof registry === "object" && !Array.isArray(registry)) {
    const token = (registry as Record<string, unknown>).token
    if (typeof token === "string") result.push(token)
  }
  const registries = parsed.registries
  if (registries && typeof registries === "object" && !Array.isArray(registries)) {
    for (const item of Object.values(registries)) {
      if (!item || typeof item !== "object" || Array.isArray(item)) continue
      const token = (item as Record<string, unknown>).token
      if (typeof token === "string") result.push(token)
    }
  }
  return result
}

export function extractKubeconfig(content: string) {
  const parsed = parseYaml(content) as Record<string, unknown> | null
  if (!parsed || typeof parsed !== "object") return []
  const result: string[] = []
  const users = parsed.users
  if (!Array.isArray(users)) return result
  for (const item of users) {
    if (!item || typeof item !== "object") continue
    const user = (item as Record<string, unknown>).user
    if (!user || typeof user !== "object" || Array.isArray(user)) continue
    const record = user as Record<string, unknown>
    for (const key of ["token", "password", "client-key-data"]) {
      const value = record[key]
      if (typeof value !== "string") continue
      result.push(value)
      if (key === "client-key-data") result.push(...decodeBase64(value))
    }
    const authProvider = record["auth-provider"]
    if (authProvider && typeof authProvider === "object" && !Array.isArray(authProvider)) {
      result.push(...collectFields((authProvider as Record<string, unknown>).config, [
        "access-token",
        "id-token",
        "refresh-token",
        "client-secret",
      ]))
    }
  }
  return result
}

export function extractDockerConfig(content: string) {
  const parsed = JSON.parse(content) as Record<string, unknown>
  const result: string[] = []
  const auths = parsed.auths
  if (auths && typeof auths === "object" && !Array.isArray(auths)) {
    for (const value of Object.values(auths)) {
      if (!value || typeof value !== "object" || Array.isArray(value)) continue
      const record = value as Record<string, unknown>
      for (const key of ["auth", "identitytoken", "registrytoken", "password"]) {
        const item = record[key]
        if (typeof item !== "string") continue
        result.push(item)
        if (key === "auth") result.push(...decodeBase64(item))
      }
    }
  }
  return result
}

export function extractGitCredentials(content: string) {
  const result: string[] = []
  for (const line of content.split("\n")) {
    const value = line.trim()
    if (!value) continue
    try {
      const url = new URL(value)
      if (url.password) result.push(decodeURIComponent(url.password))
      result.push(value)
    } catch {
      result.push(value)
    }
  }
  return result
}

export function extractNetrc(content: string) {
  const result: string[] = []
  const tokens = content.split(/\s+/)
  for (let index = 0; index < tokens.length - 1; index++) {
    if (tokens[index] === "password") result.push(tokens[index + 1]!)
  }
  return result
}

export function extractVaultToken(content: string) {
  return [content.trim()]
}

export function extractPrivateKey(content: string) {
  if (!content.includes("PRIVATE KEY")) return []
  const lines = content.split("\n").map((line) => line.trim()).filter((line) => line.length >= 6)
  return [content, ...lines]
}

export function patternsForValues(values: readonly string[]) {
  const patterns = new Set<string>()
  for (const value of values) {
    const clean = value.trim()
    if (!isUsefulSecret(clean)) continue
    addPattern(patterns, clean)
    const escaped = JSON.stringify(clean).slice(1, -1)
    if (escaped !== clean) addPattern(patterns, escaped)
    if (clean.length <= 1024) {
      addPattern(patterns, Buffer.from(clean).toString("base64"))
      addPattern(patterns, Buffer.from(clean).toString("base64url"))
    }
  }
  return [...patterns].sort((left, right) => right.length - left.length)
}

function addPattern(patterns: Set<string>, value: string) {
  if (!value || value.length < MIN_SECRET_LENGTH || value.length > MAX_PATTERN_LENGTH) return
  if (looksLikePlaceholder(value)) return
  patterns.add(value)
}

function isUsefulSecret(value: string) {
  if (!value || value.length < MIN_SECRET_LENGTH || value.length > MAX_PATTERN_LENGTH) return false
  return !looksLikePlaceholder(value)
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

function decodeBase64(value: string) {
  if (value.length < 8) return []
  try {
    const decoded = Buffer.from(value, "base64").toString("utf8")
    if (!decoded || decoded.includes("\uFFFD") || !isMostlyPrintable(decoded)) return []
    const input = value.replace(/=+$/, "")
    const output = Buffer.from(decoded).toString("base64").replace(/=+$/, "")
    return input === output ? [decoded] : []
  } catch {
    return []
  }
}

function isMostlyPrintable(value: string) {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0
    if (code < 32 && character !== "\n" && character !== "\r" && character !== "\t") return false
  }
  return true
}
