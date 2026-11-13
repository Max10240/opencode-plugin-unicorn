import { readFile, realpath, stat } from "node:fs/promises"
import { readFileSync, statSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { parse as parseIni } from "ini"
import { parse as parseToml } from "smol-toml"
import { parse as parseYaml } from "yaml"
import type { ProtectionRegistry } from "./registry.js"
import type { CustomFileOptions, ExtractFormat, ReadPolicy, WritePolicy } from "./options.js"
import type { ProtectionSource } from "./types.js"
import type { ExtractedValue } from "./extractors.js"
import {
  extractAwsCredentials,
  extractByFormat,
  extractCargoCredentials,
  extractDockerConfig,
  extractGitCredentials,
  extractKubeconfig,
  extractNetrc,
  extractNpmrc,
  extractPrivateKey,
  extractPypirc,
  extractVaultToken,
  patternsForValues,
  type ExtractorContext,
} from "./extractors.js"

export type BuiltinGroup =
  | "aiAgents"
  | "cloud"
  | "sourceControl"
  | "packageRegistries"
  | "infrastructure"
  | "plaintextTokens"
  | "sshKeys"

export type ManagedFile = {
  readonly id: string
  readonly label: string
  readonly group?: BuiltinGroup
  readonly path: string
  readonly read: ReadPolicy
  readonly write: WritePolicy
  readonly source: "builtin" | "custom"
  readonly extract: (content: string) => ExtractedValue[]
}

export type ManagedHitError = {
  readonly label: string
  readonly file: string
  readonly source?: ProtectionSource
  readonly error: unknown
}

type Definition = {
  readonly id: string
  readonly group: BuiltinGroup
  readonly label: string
  readonly paths: () => readonly string[]
  readonly read: ReadPolicy
  readonly write: WritePolicy
  readonly extract: (content: string) => ExtractedValue[]
}

export function builtinFiles(options: {
  readonly disabledGroups: ReadonlySet<string>
  readonly directory: string
  readonly home?: string
}): ManagedFile[] {
  const home = options.home ?? process.env.HOME ?? os.homedir()
  return BUILTIN_DEFINITIONS.filter((definition) => !options.disabledGroups.has(definition.group)).flatMap((definition) =>
    definition.paths().map((file) => ({
      id: definition.id,
      label: definition.label,
      group: definition.group,
      path: expandPath(file, home, options.directory),
      read: definition.read,
      write: definition.write,
      source: "builtin" as const,
      extract: definition.extract,
    })),
  )
}

export function customFiles(options: {
  readonly files: readonly CustomFileOptions[]
  readonly maxContentBytes: number
  readonly directory: string
  readonly home?: string
  readonly onError?: (error: ManagedHitError) => void
}): ManagedFile[] {
  const home = options.home ?? process.env.HOME ?? os.homedir()
  const result: ManagedFile[] = []
  for (const file of options.files) {
    const resolved = expandPath(file.path, home, options.directory)
    const compile = file.extractor ? compileExtractor(file.extractor, resolved, home, options.maxContentBytes) : undefined
    const extract = file.extractor
      ? compile && ((content: string) => compile(content).map((value) => ({ value })))
      : (content: string) => extractByFormat(content, file.format!, file.fields!)
    if (!extract) {
      options.onError?.({ label: file.label, file: resolved, source: "custom", error: new Error("Invalid custom extractor") })
      result.push({
        id: file.id,
        label: file.label,
        path: resolved,
        read: "block",
        write: "block",
        source: "custom",
        extract: () => [],
      })
      continue
    }
    result.push({
      id: file.id,
      label: file.label,
      path: resolved,
      read: file.read,
      write: file.write,
      source: "custom",
      extract,
    })
  }
  return result
}

export class ManagedFiles {
  private readonly states = new Map<string, string>()
  private timer: NodeJS.Timeout | undefined
  private running: Promise<void> | undefined

  constructor(
    private readonly registry: ProtectionRegistry,
    private readonly files: readonly ManagedFile[],
    private readonly maxContentBytes: number,
    private readonly onError: (error: ManagedHitError) => void,
  ) {}

  async start() {
    await this.refreshAll()
    this.timer = setInterval(() => {
      void this.refreshAll()
    }, 2_000)
    this.timer.unref?.()
  }

  async stop() {
    if (this.timer !== undefined) {
      clearInterval(this.timer)
      this.timer = undefined
    }
    await this.running
    for (const file of this.files) {
      await this.remove(file)
    }
  }

  async refreshAll() {
    if (this.running) return this.running
    this.running = (async () => {
      for (const file of this.files) {
        await this.refresh(file)
      }
    })().finally(() => {
      this.running = undefined
    })
    return this.running
  }

  private async refresh(file: ManagedFile) {
    let resolved: string
    let info: Awaited<ReturnType<typeof stat>>
    try {
      resolved = await realpath(file.path)
      info = await stat(resolved)
    } catch {
      await this.remove(file)
      return
    }
    if (!info.isFile()) {
      await this.remove(file)
      return
    }

    const current = this.registry.get(resolved)
    if (current && current.source !== file.source && !(file.source === "custom" && current.source === "builtin")) return

    const signature = `${info.mtimeMs}:${info.size}:${info.ino}`
    if (this.states.get(resolved) === signature) return
    this.states.set(resolved, signature)
    if (info.size > this.maxContentBytes) {
      this.onError({ label: file.label, file: resolved, source: file.source, error: new Error("File exceeds maxContentBytes") })
      await this.blockOnError(file, resolved)
      return
    }

    let content: string
    try {
      content = await readFile(resolved, "utf8")
    } catch (error) {
      this.onError({ label: file.label, file: resolved, source: file.source, error })
      await this.blockOnError(file, resolved)
      return
    }

    let values: ExtractedValue[]
    try {
      values = file.extract(content)
    } catch (error) {
      this.onError({ label: file.label, file: resolved, source: file.source, error })
      await this.blockOnError(file, resolved)
      return
    }

    const patterns = patternsForValues(values)
    if (patterns.length === 0 && file.read !== "block") {
      await this.remove(file)
      return
    }
    try {
      await this.registry.registerPatterns(resolved, patterns, {
        role: file.source,
        label: file.label,
        read: file.read,
        write: file.write,
        source: file.source,
        persist: false,
      })
    } catch (error) {
      this.onError({ label: file.label, file: resolved, source: file.source, error })
    }
  }

  private async blockOnError(file: ManagedFile, resolved: string) {
    try {
      await this.registry.registerPatterns(resolved, [], {
        role: file.source,
        label: file.label,
        read: "block",
        write: "block",
        source: file.source,
        persist: false,
      })
    } catch {
      // The path may have disappeared between stat and registration.
    }
  }

  private async remove(file: ManagedFile) {
    let resolved: string
    try {
      resolved = await realpath(file.path)
    } catch {
      resolved = file.path
    }
    this.states.delete(resolved)
    const current = this.registry.get(resolved)
    if (current?.source === file.source) this.registry.remove(resolved)
  }
}

function compileExtractor(code: string, file: string, home: string, maxContentBytes: number) {
  try {
    const read = (value?: string) => {
      const target = value ? expandPath(value, home, path.dirname(file)) : file
      const info = statSync(target)
      if (!info.isFile()) throw new Error("Protected file must be a regular file")
      if (info.size > maxContentBytes) throw new Error(`File exceeds ${maxContentBytes} bytes`)
      return readFileSync(target, "utf8")
    }
    const context: ExtractorContext = Object.freeze({
      file,
      home,
      readFile: read,
      parseJson: (text?: string) => JSON.parse(text ?? read()),
      parseYaml: (text?: string) => parseYaml(text ?? read()),
      parseIni: (text?: string) => parseIni(text ?? read()),
      parseToml: (text?: string) => parseToml(text ?? read()) as unknown,
    }) as ExtractorContext
    const fn = new Function("context", `"use strict";\n${code}`) as (context: ExtractorContext) => unknown
    return (content: string) => {
      const result = fn({ ...context, file, readFile: (value?: string) => (value ? read(value) : content) })
      if (!Array.isArray(result)) throw new Error("Extractor must return string[]")
      return result.filter((value): value is string => typeof value === "string")
    }
  } catch {
    return undefined
  }
}

function expandPath(value: string, home: string, directory: string) {
  const expanded = value === "~" ? home : value.startsWith("~/") ? path.join(home, value.slice(2)) : value
  return path.isAbsolute(expanded) ? expanded : path.resolve(directory, expanded)
}

function fields(format: ExtractFormat, values: readonly string[]) {
  return (content: string) => extractByFormat(content, format, values)
}

const BUILTIN_DEFINITIONS: readonly Definition[] = [
  {
    id: "opencode-auth",
    group: "aiAgents",
    label: "OpenCode auth",
    paths: () => [path.join(dataHome(), "opencode", "auth.json")],
    read: "redact",
    write: "block",
    extract: fields("json", ["key", "token", "access", "refresh"]),
  },
  {
    id: "codex-auth",
    group: "aiAgents",
    label: "Codex auth",
    paths: () => [path.join(process.env.CODEX_HOME || path.join(home(), ".codex"), "auth.json")],
    read: "redact",
    write: "block",
    extract: fields("json", ["OPENAI_API_KEY", "personal_access_token", "access_token", "refresh_token", "id_token"]),
  },
  {
    id: "claude-credentials",
    group: "aiAgents",
    label: "Claude credentials",
    paths: () => [path.join(process.env.CLAUDE_CONFIG_DIR || path.join(home(), ".claude"), ".credentials.json")],
    read: "redact",
    write: "block",
    extract: fields("json", ["accessToken", "refreshToken"]),
  },
  {
    id: "gemini-oauth",
    group: "aiAgents",
    label: "Gemini credentials",
    paths: () => [path.join(process.env.GEMINI_CLI_HOME || home(), ".gemini", "oauth_creds.json")],
    read: "redact",
    write: "block",
    extract: fields("json", ["access_token", "refresh_token", "id_token"]),
  },
  {
    id: "gcp-adc",
    group: "cloud",
    label: "Google ADC",
    paths: () => [path.join(cloudSdkConfig(), "application_default_credentials.json")],
    read: "redact",
    write: "block",
    extract: fields("json", ["client_secret", "refresh_token", "private_key", "access_token"]),
  },
  {
    id: "aws-credentials",
    group: "cloud",
    label: "AWS credentials",
    paths: () => [process.env.AWS_SHARED_CREDENTIALS_FILE || path.join(home(), ".aws", "credentials")],
    read: "redact",
    write: "block",
    extract: extractAwsCredentials,
  },
  {
    id: "kubeconfig",
    group: "cloud",
    label: "Kubernetes kubeconfig",
    paths: () => kubeconfigPaths(),
    read: "redact",
    write: "block",
    extract: extractKubeconfig,
  },
  {
    id: "gh-hosts",
    group: "sourceControl",
    label: "GitHub CLI hosts",
    paths: () => [githubHostsPath()],
    read: "redact",
    write: "block",
    extract: fields("yaml", ["oauth_token", "token"]),
  },
  {
    id: "npmrc",
    group: "packageRegistries",
    label: "npm auth",
    paths: () => [process.env.NPM_CONFIG_USERCONFIG || path.join(home(), ".npmrc")],
    read: "redact",
    write: "block",
    extract: extractNpmrc,
  },
  {
    id: "pypirc",
    group: "packageRegistries",
    label: "PyPI auth",
    paths: () => [path.join(home(), ".pypirc")],
    read: "redact",
    write: "block",
    extract: extractPypirc,
  },
  {
    id: "cargo-credentials",
    group: "packageRegistries",
    label: "Cargo credentials",
    paths: () => {
      const root = process.env.CARGO_HOME || path.join(home(), ".cargo")
      return [path.join(root, "credentials.toml"), path.join(root, "credentials")]
    },
    read: "redact",
    write: "block",
    extract: extractCargoCredentials,
  },
  {
    id: "terraform-credentials",
    group: "infrastructure",
    label: "Terraform credentials",
    paths: () => [path.join(terraformDirectory(), "credentials.tfrc.json")],
    read: "redact",
    write: "block",
    extract: (content) => {
      const parsed = JSON.parse(content) as Record<string, unknown>
      const credentials = parsed.credentials
      if (!credentials || typeof credentials !== "object" || Array.isArray(credentials)) return []
      return Object.entries(credentials).flatMap(([host, value]) => {
        if (!value || typeof value !== "object" || Array.isArray(value)) return []
        const token = (value as Record<string, unknown>).token
        return typeof token === "string" ? [{ value: token, key: `credentials.${host}.token` }] : []
      })
    },
  },
  {
    id: "docker-config",
    group: "infrastructure",
    label: "Docker registry credentials",
    paths: () => [path.join(process.env.DOCKER_CONFIG || path.join(home(), ".docker"), "config.json")],
    read: "redact",
    write: "block",
    extract: extractDockerConfig,
  },
  {
    id: "git-credentials",
    group: "sourceControl",
    label: "Git credentials",
    paths: () => [path.join(home(), ".git-credentials"), path.join(configHome(), "git", "credentials")],
    read: "redact",
    write: "block",
    extract: extractGitCredentials,
  },
  {
    id: "netrc",
    group: "plaintextTokens",
    label: "netrc credentials",
    paths: () => [path.join(home(), ".netrc"), path.join(home(), "_netrc")],
    read: "redact",
    write: "block",
    extract: extractNetrc,
  },
  {
    id: "vault-token",
    group: "plaintextTokens",
    label: "Vault token",
    paths: () => [path.join(home(), ".vault-token")],
    read: "block",
    write: "block",
    extract: extractVaultToken,
  },
  {
    id: "ssh-private",
    group: "sshKeys",
    label: "SSH private key",
    paths: () => ["id_rsa", "id_ed25519", "id_ecdsa", "id_dsa"].map((name) => path.join(home(), ".ssh", name)),
    read: "block",
    write: "block",
    extract: extractPrivateKey,
  },
]

function home() {
  return process.env.HOME || os.homedir()
}

function configHome() {
  return process.env.XDG_CONFIG_HOME || path.join(home(), ".config")
}

function dataHome() {
  return process.env.XDG_DATA_HOME || path.join(home(), ".local", "share")
}

function cloudSdkConfig() {
  if (process.env.CLOUDSDK_CONFIG) return process.env.CLOUDSDK_CONFIG
  if (process.platform === "win32" && process.env.APPDATA) return path.join(process.env.APPDATA, "gcloud")
  return path.join(configHome(), "gcloud")
}

function githubHostsPath() {
  if (process.platform === "win32" && process.env.APPDATA) return path.join(process.env.APPDATA, "GitHub CLI", "hosts.yml")
  return path.join(configHome(), "gh", "hosts.yml")
}

function terraformDirectory() {
  if (process.platform === "win32" && process.env.APPDATA) return path.join(process.env.APPDATA, "terraform.d")
  return path.join(home(), ".terraform.d")
}

function kubeconfigPaths() {
  const configured = process.env.KUBECONFIG
  if (configured) return configured.split(path.delimiter).filter(Boolean).map((value) => expandPath(value, home(), home()))
  return [path.join(home(), ".kube", "config")]
}
