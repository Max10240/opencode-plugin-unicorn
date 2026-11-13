import { parse as parseIni } from "ini"
import { parse as parseToml } from "smol-toml"
import { parse as parseYaml } from "yaml"
import type { ExtractFormat } from "./options.js"
import type { ProtectionPattern } from "./types.js"

export type ExtractedValue = {
  readonly value: string
  readonly key?: string
}

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

/** Walks parsed data and returns only the configured secret fields together with their key path. */
export function collectFieldValues(
  value: unknown,
  fields: readonly string[],
  prefix: readonly (string | number)[] = [],
): ExtractedValue[] {
  const wanted = new Set(fields.map(normalizeKey))
  const result: ExtractedValue[] = []
  const seen = new Set<unknown>()
  const walk = (item: unknown, path: readonly (string | number)[]) => {
    if (typeof item === "string") return
    if (!item || typeof item !== "object") return
    if (seen.has(item)) return
    seen.add(item)
    if (Array.isArray(item)) {
      item.forEach((child, index) => walk(child, [...path, index]))
      return
    }
    for (const [key, child] of Object.entries(item)) {
      const next = [...path, key]
      if (typeof child === "string" && wanted.has(normalizeKey(key))) result.push({ value: child, key: formatPath(next) })
      else walk(child, next)
    }
  }
  walk(value, prefix)
  return result
}

export function collectFields(value: unknown, fields: readonly string[]): string[] {
  return collectFieldValues(value, fields).map((item) => item.value)
}

export function extractByFormat(content: string, format: ExtractFormat, fields: readonly string[]): ExtractedValue[] {
  const parsed = parseContent(format, content)
  return format === "ini" ? collectIniValues(parsed, fields) : collectFieldValues(parsed, fields)
}

function collectIniValues(value: unknown, fields: readonly string[]): ExtractedValue[] {
  const wanted = new Set(fields.map(normalizeKey))
  const result: ExtractedValue[] = []
  const seen = new Set<unknown>()
  const walk = (item: unknown, path: readonly (string | number)[]) => {
    if (!item || typeof item !== "object" || seen.has(item)) return
    seen.add(item)
    if (Array.isArray(item)) {
      item.forEach((child, index) => walk(child, [...path, index]))
      return
    }
    for (const [key, child] of Object.entries(item)) {
      const next = [...path, key]
      if (typeof child === "string") {
        const suffix = key.slice(key.lastIndexOf(":") + 1)
        if (wanted.has(normalizeKey(key)) || wanted.has(normalizeKey(suffix))) {
          result.push({ value: child, key: formatPath(next) })
        }
      } else {
        walk(child, next)
      }
    }
  }
  walk(value, [])
  return result
}

function collectIniFields(value: unknown, fields: readonly string[]): string[] {
  return collectIniValues(value, fields).map((item) => item.value)
}

export function extractNpmrc(content: string) {
  const parsed = parseIni(content)
  const result: ExtractedValue[] = []
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value !== "string") continue
    const suffix = key.slice(key.lastIndexOf(":") + 1)
    const normalized = normalizeKey(suffix)
    if (normalized !== "authtoken" && normalized !== "auth" && normalized !== "password") continue
    const label = npmKey(key, suffix)
    result.push({ value, key: label })
    if (normalized === "auth" || normalized === "password") {
      for (const decoded of decodeBase64(value)) result.push({ value: decoded, key: `${label} (decoded)` })
    }
  }
  return result
}

export function extractAwsCredentials(content: string) {
  return collectFieldValues(parseIni(content), [
    "aws_access_key_id",
    "aws_secret_access_key",
    "aws_session_token",
  ])
}

export function extractPypirc(content: string) {
  return collectFieldValues(parseIni(content), ["password"])
}

export function extractCargoCredentials(content: string) {
  const parsed = parseToml(content) as Record<string, unknown>
  const result: ExtractedValue[] = []
  const registry = parsed.registry
  if (registry && typeof registry === "object" && !Array.isArray(registry)) {
    const token = (registry as Record<string, unknown>).token
    if (typeof token === "string") result.push({ value: token, key: "registry.token" })
  }
  const registries = parsed.registries
  if (registries && typeof registries === "object" && !Array.isArray(registries)) {
    for (const [name, item] of Object.entries(registries)) {
      if (!item || typeof item !== "object" || Array.isArray(item)) continue
      const token = (item as Record<string, unknown>).token
      if (typeof token === "string") result.push({ value: token, key: `registries.${name}.token` })
    }
  }
  return result
}

export function extractKubeconfig(content: string) {
  const parsed = parseYaml(content) as Record<string, unknown> | null
  if (!parsed || typeof parsed !== "object") return []
  const result: ExtractedValue[] = []
  const users = parsed.users
  if (!Array.isArray(users)) return result
  for (const [index, item] of users.entries()) {
    if (!item || typeof item !== "object") continue
    const user = (item as Record<string, unknown>).user
    if (!user || typeof user !== "object" || Array.isArray(user)) continue
    const record = user as Record<string, unknown>
    const name = (item as Record<string, unknown>).name
    const owner = `users[${typeof name === "string" && name ? name : index}].user`
    for (const key of ["token", "password", "client-key-data"]) {
      const value = record[key]
      if (typeof value !== "string") continue
      result.push({ value, key: `${owner}.${key}` })
      if (key === "client-key-data") {
        for (const decoded of decodeBase64(value)) result.push({ value: decoded, key: `${owner}.${key} (decoded)` })
      }
    }
    const authProvider = record["auth-provider"]
    if (authProvider && typeof authProvider === "object" && !Array.isArray(authProvider)) {
      result.push(...collectFieldValues((authProvider as Record<string, unknown>).config, [
        "access-token",
        "id-token",
        "refresh-token",
        "client-secret",
      ], [owner, "auth-provider", "config"]))
    }
  }
  return result
}

export function extractDockerConfig(content: string) {
  const parsed = JSON.parse(content) as Record<string, unknown>
  const result: ExtractedValue[] = []
  const auths = parsed.auths
  if (auths && typeof auths === "object" && !Array.isArray(auths)) {
    for (const [registry, value] of Object.entries(auths)) {
      if (!value || typeof value !== "object" || Array.isArray(value)) continue
      const record = value as Record<string, unknown>
      for (const key of ["auth", "identitytoken", "registrytoken", "password"]) {
        const item = record[key]
        if (typeof item !== "string") continue
        const label = `auths.${registry}.${key}`
        result.push({ value: item, key: label })
        if (key === "auth") {
          for (const decoded of decodeBase64(item)) result.push({ value: decoded, key: `${label} (decoded)` })
        }
      }
    }
  }
  return result
}

export function extractGitCredentials(content: string) {
  const result: ExtractedValue[] = []
  for (const line of content.split("\n")) {
    const value = line.trim()
    if (!value) continue
    try {
      const url = new URL(value)
      if (url.password) result.push({ value: decodeURIComponent(url.password), key: `password @ ${url.host}` })
      result.push({ value, key: `credential line @ ${url.host}` })
    } catch {
      result.push({ value, key: "credential line" })
    }
  }
  return result
}

export function extractNetrc(content: string) {
  const result: ExtractedValue[] = []
  const tokens = content.split(/\s+/)
  let machine: string | undefined
  for (let index = 0; index < tokens.length - 1; index++) {
    if (tokens[index] === "machine") {
      machine = tokens[index + 1]
      continue
    }
    if (tokens[index] === "password" && tokens[index + 1]) {
      result.push({ value: tokens[index + 1]!, key: machine ? `password @ ${machine}` : "password" })
      index++
    }
  }
  return result
}

export function extractVaultToken(content: string) {
  return [{ value: content.trim(), key: "token" }]
}

export function extractPrivateKey(content: string) {
  if (!content.includes("PRIVATE KEY")) return []
  const lines = content.split("\n").map((line) => line.trim()).filter((line) => line.length >= 6)
  return [
    { value: content, key: "private key" },
    ...lines.map((line) => ({ value: line, key: "private key line" })),
  ]
}

export function patternsForValues(values: readonly (string | ExtractedValue)[]): ProtectionPattern[] {
  const patterns = new Map<string, ProtectionPattern>()
  const add = (value: string, key: string | undefined) => {
    if (!value || value.length < MIN_SECRET_LENGTH || value.length > MAX_PATTERN_LENGTH) return
    if (looksLikePlaceholder(value)) return
    if (!patterns.has(value)) patterns.set(value, key === undefined ? { value } : { value, key })
  }
  for (const item of values) {
    const raw = typeof item === "string" ? item : item.value
    const key = typeof item === "string" ? undefined : item.key
    const clean = raw.trim()
    if (!isUsefulSecret(clean)) continue
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

function formatPath(path: readonly (string | number)[]) {
  let result = ""
  for (const part of path) {
    if (typeof part === "number") result += `[${part}]`
    else result += result ? `.${part}` : part
  }
  return result
}

function npmKey(key: string, suffix: string) {
  const separator = key.lastIndexOf(":")
  if (separator < 0) return suffix
  const scope = key.slice(0, separator).replace(/^\/\//, "").replace(/\/$/, "")
  return scope ? `${suffix} @ ${scope}` : suffix
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
