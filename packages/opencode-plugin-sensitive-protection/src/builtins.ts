import { readFile, realpath, stat } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { ProtectionRegistry } from "./registry.js"
import type { FileConfig } from "./options.js"
import type { ExtractFormat } from "./spec.js"
import { extractContent, patternsForValues, type ExtractResult } from "./spec.js"
import type { ProtectionSource } from "./types.js"
import type { ProtectionHub } from "./hub.js"

export type ManagedFile = {
  readonly id: string
  readonly label: string
  readonly path: string
  readonly format: ExtractFormat
  readonly keys: readonly string[]
  readonly source: "default" | "config"
  readonly project?: string
}

export type ManagedHitError = {
  readonly label: string
  readonly file: string
  readonly source?: ProtectionSource
  readonly error: unknown
}

type Definition = {
  readonly id: string
  readonly label: string
  readonly paths: () => readonly string[]
  readonly format: ExtractFormat
  readonly keys: readonly string[]
}

export function builtinFiles(options: {
  readonly directory: string
  readonly home?: string
}): ManagedFile[] {
  const home = options.home ?? process.env.HOME ?? os.homedir()
  return BUILTIN_DEFINITIONS.flatMap((definition) =>
    definition.paths().map((file) => ({
      id: definition.id,
      label: definition.label,
      path: expandPath(file, home, options.directory),
      format: definition.format,
      keys: definition.keys,
      source: "default" as const,
    })),
  )
}

export function configFiles(options: {
  readonly files: readonly FileConfig[]
  readonly directory: string
  readonly home?: string
}): ManagedFile[] {
  const home = options.home ?? process.env.HOME ?? os.homedir()
  return options.files.map((file, index) => ({
    id: `config-${index}`,
    label: file.label ?? file.path,
    path: expandPath(file.path, home, options.directory),
    format: file.format,
    keys: file.keys,
    source: "config" as const,
    project: options.directory,
  }))
}

const SOURCE_PRIORITY: Record<ProtectionSource, number> = { default: 0, manual: 1, config: 2 }

export class ManagedFiles {
  private readonly states = new Map<string, string>()
  private readonly locationFiles = new Map<string, {
    path: string
    source: "default" | "config"
    format: ExtractFormat
    keys: readonly string[]
    keyCount: number
    label?: string
    project?: string
    invalid?: string
  }>()
  private timer: NodeJS.Timeout | undefined
  private running: Promise<void> | undefined

  constructor(
    private readonly registry: ProtectionRegistry,
    private readonly files: readonly ManagedFile[],
    private readonly maxContentBytes: number,
    private readonly hub: ProtectionHub,
    private readonly locationKey: string,
    private readonly directory: string,
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
    for (const file of this.files) await this.remove(file)
    this.hub.removeLocation(this.locationKey)
  }

  invalidate() {
    this.states.clear()
  }

  async refreshAll() {
    if (this.running) return this.running
    this.running = (async () => {
      for (const file of this.files) await this.refresh(file)
      this.hub.setLocation(this.locationKey, this.directory, [...this.locationFiles.values()])
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
    if (this.hub.isDisabled(resolved, this.directory, file.source)) {
      await this.remove(file)
      return
    }
    const current = this.registry.get(resolved)
    if (current && SOURCE_PRIORITY[current.source] > SOURCE_PRIORITY[file.source]) return
    const signature = `${info.mtimeMs}:${info.size}:${info.ino}`
    if (this.states.get(resolved) === signature) return
    this.states.set(resolved, signature)
    if (info.size > this.maxContentBytes) {
      await this.blockOnError(file, resolved, new Error("File exceeds maxContentBytes"))
      return
    }
    let content: string
    try {
      content = await readFile(resolved, "utf8")
    } catch (error) {
      await this.blockOnError(file, resolved, error)
      return
    }
    let result: ExtractResult
    try {
      result = extractContent(content, file.format, file.keys, { strict: file.source === "config" })
    } catch (error) {
      await this.blockOnError(file, resolved, error)
      return
    }
    if (file.source === "config" && result.missing.length > 0) {
      await this.blockOnError(
        file,
        resolved,
        new Error(`Missing keys: ${result.missing.join(", ")}. Available keys: ${result.available.join(", ")}`),
      )
      return
    }
    if (result.values.length === 0) {
      if (file.source === "default" && file.format !== "private-key" && file.format !== "line") {
        await this.remove(file, resolved)
        return
      }
      await this.blockOnError(file, resolved, new Error(`No values matched keys: ${file.keys.join(", ")}`))
      return
    }
    const patterns = patternsForValues(result.values)
    if (patterns.length === 0) {
      if (file.source === "default") {
        await this.remove(file, resolved)
        return
      }
      await this.blockOnError(file, resolved, new Error("No protectable secret value was found"))
      return
    }
    this.registry.set({
      path: resolved,
      source: file.source,
      format: file.format,
      keys: file.keys,
      label: file.label,
      createdAt: Date.now(),
    }, patterns)
    this.locationFiles.set(resolved, {
      path: resolved,
      source: file.source,
      format: file.format,
      keys: file.keys,
      keyCount: file.keys.length,
      ...(file.label === undefined ? {} : { label: file.label }),
      ...(file.project === undefined ? {} : { project: file.project }),
    })
  }

  private async blockOnError(file: ManagedFile, resolved: string, error: unknown) {
    const current = this.registry.get(resolved)
    if (current && SOURCE_PRIORITY[current.source] > SOURCE_PRIORITY[file.source]) return
    this.onError({ label: file.label, file: resolved, source: file.source, error })
    this.registry.set({
      path: resolved,
      source: file.source,
      format: file.format,
      keys: file.keys,
      label: file.label,
      createdAt: Date.now(),
      invalid: safeError(error),
    }, [])
    this.locationFiles.set(resolved, {
      path: resolved,
      source: file.source,
      format: file.format,
      keys: file.keys,
      keyCount: 0,
      ...(file.label === undefined ? {} : { label: file.label }),
      ...(file.project === undefined ? {} : { project: file.project }),
      invalid: safeError(error),
    })
  }

  private async remove(file: ManagedFile, resolved?: string) {
    if (resolved === undefined) {
      try {
        resolved = await realpath(file.path)
      } catch {
        resolved = file.path
      }
    }
    this.states.delete(resolved)
    this.locationFiles.delete(resolved)
    const current = this.registry.get(resolved)
    if (current?.source === file.source) this.registry.remove(resolved)
  }
}

function expandPath(value: string, home: string, directory: string) {
  const expanded = value === "~" ? home : value.startsWith("~/") ? path.join(home, value.slice(2)) : value
  return path.isAbsolute(expanded) ? expanded : path.resolve(directory, expanded)
}

function safeError(error: unknown) {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "File could not be parsed"
  return message.replace(/[\u0000-\u001F\u007F-\u009F]/g, " ").slice(0, 300)
}

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

const BUILTIN_DEFINITIONS: readonly Definition[] = [
  {
    id: "opencode-auth",
    label: "OpenCode auth",
    paths: () => [path.join(dataHome(), "opencode", "auth.json")],
    format: "json",
    keys: ["key", "token", "access", "refresh"],
  },
  {
    id: "codex-auth",
    label: "Codex auth",
    paths: () => [path.join(process.env.CODEX_HOME || path.join(home(), ".codex"), "auth.json")],
    format: "json",
    keys: ["OPENAI_API_KEY", "personal_access_token", "access_token", "refresh_token", "id_token"],
  },
  {
    id: "claude-credentials",
    label: "Claude credentials",
    paths: () => [path.join(process.env.CLAUDE_CONFIG_DIR || path.join(home(), ".claude"), ".credentials.json")],
    format: "json",
    keys: ["accessToken", "refreshToken"],
  },
  {
    id: "gemini-oauth",
    label: "Gemini credentials",
    paths: () => [path.join(process.env.GEMINI_CLI_HOME || home(), ".gemini", "oauth_creds.json")],
    format: "json",
    keys: ["access_token", "refresh_token", "id_token"],
  },
  {
    id: "gcp-adc",
    label: "Google ADC",
    paths: () => [path.join(cloudSdkConfig(), "application_default_credentials.json")],
    format: "json",
    keys: ["client_secret", "refresh_token", "private_key", "access_token"],
  },
  {
    id: "aws-credentials",
    label: "AWS credentials",
    paths: () => [process.env.AWS_SHARED_CREDENTIALS_FILE || path.join(home(), ".aws", "credentials")],
    format: "ini",
    keys: ["aws_access_key_id", "aws_secret_access_key", "aws_session_token"],
  },
  {
    id: "kubeconfig",
    label: "Kubernetes kubeconfig",
    paths: () => kubeconfigPaths(),
    format: "yaml",
    keys: ["token", "password", "client-key-data"],
  },
  {
    id: "gh-hosts",
    label: "GitHub CLI hosts",
    paths: () => [githubHostsPath()],
    format: "yaml",
    keys: ["oauth_token", "token"],
  },
  {
    id: "npmrc",
    label: "npm auth",
    paths: () => [process.env.NPM_CONFIG_USERCONFIG || path.join(home(), ".npmrc")],
    format: "ini",
    keys: ["*_authToken", "*_auth", "*_password"],
  },
  {
    id: "pypirc",
    label: "PyPI auth",
    paths: () => [path.join(home(), ".pypirc")],
    format: "ini",
    keys: ["password"],
  },
  {
    id: "cargo-credentials",
    label: "Cargo credentials",
    paths: () => {
      const root = process.env.CARGO_HOME || path.join(home(), ".cargo")
      return [path.join(root, "credentials.toml"), path.join(root, "credentials")]
    },
    format: "toml",
    keys: ["token"],
  },
  {
    id: "terraform-credentials",
    label: "Terraform credentials",
    paths: () => [path.join(terraformDirectory(), "credentials.tfrc.json")],
    format: "json",
    keys: ["token"],
  },
  {
    id: "docker-config",
    label: "Docker registry credentials",
    paths: () => [path.join(process.env.DOCKER_CONFIG || path.join(home(), ".docker"), "config.json")],
    format: "json",
    keys: ["auths.*.auth", "auths.*.identitytoken", "auths.*.registrytoken"],
  },
  {
    id: "git-credentials",
    label: "Git credentials",
    paths: () => [path.join(home(), ".git-credentials"), path.join(configHome(), "git", "credentials")],
    format: "git-credentials",
    keys: ["password"],
  },
  {
    id: "netrc",
    label: "netrc credentials",
    paths: () => [path.join(home(), ".netrc"), path.join(home(), "_netrc")],
    format: "netrc",
    keys: ["password"],
  },
  {
    id: "vault-token",
    label: "Vault token",
    paths: () => [path.join(home(), ".vault-token")],
    format: "line",
    keys: ["line"],
  },
  {
    id: "ssh-private",
    label: "SSH private key",
    paths: () => ["id_rsa", "id_ed25519", "id_ecdsa", "id_dsa"].map((name) => path.join(home(), ".ssh", name)),
    format: "private-key",
    keys: ["private key body"],
  },
]
