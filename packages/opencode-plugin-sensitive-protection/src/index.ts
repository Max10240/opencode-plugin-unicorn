import { Plugin } from "@opencode/plugin"
import type { Context } from "@opencode/plugin/promise/plugin"
import { Error as ToolError } from "@opencode/plugin/promise/tool"
import { readFile, realpath, stat } from "node:fs/promises"
import { parseProtectionOptions, type ResolvedProtectionOptions } from "./options.js"
import { ProtectionRegistry, REDACTION_TOKEN } from "./registry.js"
import { builtinFiles, configFiles, ManagedFiles } from "./builtins.js"
import { ProtectionHistory } from "./history.js"
import { ProtectionRpc, type ProtectionFilesResult, type ProtectionPendingResult, type ProtectionRequest, type ProtectionHistoryResult } from "./rpc.js"
import { acquireHub, type ProtectionHub } from "./hub.js"
import { expandProtectedPath, resolveProtectedPath } from "./paths.js"
import {
  detectFormat,
  extractContent,
  isPrivateKey,
  isStructuredFormat,
  nonEmptyLines,
  patternsForValues,
  type ExtractFormat,
} from "./spec.js"
import type { ProtectionMatch } from "./types.js"

export { REDACTION_TOKEN } from "./registry.js"

export const REGISTER_TOOL_NAME = "register_sensitive_file"
export const UNPROTECT_REQUEST_TOOL_NAME = "request_sensitive_unprotect"

type PluginContext = Pick<Context, "options" | "location" | "tool" | "session" | "command"> & Partial<Pick<Context, "rpc">>

type RegisterInput = {
  readonly file: string
  readonly format?: ExtractFormat
  readonly keys?: readonly string[]
  readonly inspect?: boolean
  readonly label?: string
  readonly role?: "encrypt-input" | "decrypt-output" | "manual"
  readonly keyID?: string
  readonly sessionID?: string
  readonly toolCallID?: string
}

export async function setupSensitiveProtection(context: PluginContext) {
  let options: ResolvedProtectionOptions
  try {
    options = await parseProtectionOptions(context.options, context.location.directory)
  } catch (error) {
    console.warn(`Sensitive protection disabled: ${error instanceof Error ? error.message : "invalid options"}`)
    return async () => {}
  }
  if (!options.enabled) return async () => {}

  const hub = await acquireHub(options.dataDirectory, options.maxContentBytes)
  const registry = new ProtectionRegistry()
  const history = new ProtectionHistory(options.historyLimit)

  let notifyHit: ((hit: import("./types.js").ProtectionHit) => void) | undefined
  let notifyCleared: (() => void) | undefined
  let notifyPending: ((count: number) => void) | undefined
  let notifyFiles: ((count: number) => void) | undefined
  let rpcDispose: (() => Promise<void> | void) | undefined
  let disposeHub: (() => void) | undefined
  let disposeRegistry: (() => void) | undefined

  const notify = (hit: Omit<import("./types.js").ProtectionHit, "id" | "time" | "firstTime" | "occurrences">) => {
    const recorded = history.record(hit)
    notifyHit?.(recorded)
  }
  for (const error of options.fileErrors) {
    console.warn(`Sensitive protection config: ${error}`)
    notify({ kind: "error", source: "parser", count: 0, label: error, detail: error })
  }
  const notifyError = (error: { label: string; file: string; source?: ProtectionMatch["source"]; error: unknown }) => {
    notify({
      kind: "error",
      source: "parser",
      count: 0,
      label: error.label,
      file: error.file,
      detail: safeErrorDetail(error.error),
      matches: [{
        file: error.file,
        label: error.label,
        ...(error.source === undefined ? {} : { source: error.source }),
        count: 0,
      }],
    })
  }

  const configExclusions: string[] = []
  for (const value of options.exclusions) {
    const expanded = expandProtectedPath(value, context.location.directory)
    configExclusions.push(await realpath(expanded).catch(() => expanded))
  }
  hub.setConfigExclusions(context.location.directory, configExclusions)
  const managedFiles = [
    ...builtinFiles({ directory: context.location.directory }),
    ...configFiles({ files: options.files, directory: context.location.directory }),
  ]
  const manager = new ManagedFiles(
    registry,
    managedFiles,
    options.maxContentBytes,
    hub,
    context.location.directory,
    context.location.directory,
    notifyError,
  )

  let manualPaths = new Set<string>()
  const syncManual = () => {
    const next = new Set<string>()
    for (const item of hub.manualEntries(context.location.directory)) {
      const current = registry.get(item.entry.path)
      if (current?.source === "config") continue
      const entry = {
        path: item.entry.path,
        source: "manual" as const,
        format: item.entry.format,
        keys: item.entry.keys,
        ...(item.entry.label === undefined ? {} : { label: item.entry.label }),
        ...(item.entry.role === undefined ? {} : { role: item.entry.role }),
        ...(item.entry.keyID === undefined ? {} : { keyID: item.entry.keyID }),
        createdAt: item.entry.createdAt,
        ...(item.invalid === undefined ? {} : { invalid: item.invalid }),
      }
      registry.set(entry, item.patterns)
      next.add(item.entry.path)
    }
    for (const path of manualPaths) {
      if (!next.has(path)) {
        const current = registry.get(path)
        if (current?.source === "manual") registry.remove(path)
      }
    }
    manualPaths = next
    manager.invalidate()
    void manager.refreshAll()
  }

  const emitFiles = () => {
    notifyFiles?.(hub.catalog().length)
  }

  if (context.rpc) {
    try {
      const registration = await context.rpc.register(ProtectionRpc, {
        history: async (): Promise<ProtectionHistoryResult> => ({
          hits: history.list(),
          total: history.size,
          limit: options.historyLimit,
        }),
        files: async (): Promise<ProtectionFilesResult> => {
          const files = hub.catalog()
          return { files, total: files.length, refreshedAt: Date.now() }
        },
        clear: async () => {
          const cleared = history.clear()
          notifyCleared?.()
          return { cleared }
        },
        unprotect: async (rawInput) => {
          const input = rawInput as { path?: unknown }
          if (typeof input.path !== "string" || !input.path.trim()) throw new Error("path is required")
          const value = input.path
          const resolved = await resolveProtectedPath(value, context.location.directory).catch(() => expandProtectedPath(value, context.location.directory))
          return hub.unprotect(resolved, context.location.directory)
        },
        restore: async (rawInput) => {
          const input = rawInput as { path?: unknown }
          if (typeof input.path !== "string" || !input.path.trim()) throw new Error("path is required")
          const value = input.path
          const resolved = await resolveProtectedPath(value, context.location.directory).catch(() => expandProtectedPath(value, context.location.directory))
          const restored = await hub.restore(resolved)
          if (restored) await manager.refreshAll()
          return { restored }
        },
        pending: async (): Promise<ProtectionPendingResult> => {
          const requests = hub.listPending() as ProtectionRequest[]
          return { requests, count: requests.length }
        },
        resolve: async (rawInput) => {
          const input = rawInput as { id?: unknown; approve?: unknown }
          if (typeof input.id !== "string" || typeof input.approve !== "boolean") throw new Error("id and approve are required")
          return { resolved: await hub.resolvePending(input.id, input.approve) }
        },
      })
      rpcDispose = () => registration.dispose()
      notifyHit = (hit) => {
        void registration.events.emit("hit", hit).catch(() => {})
      }
      notifyCleared = () => {
        void registration.events.emit("cleared", {}).catch(() => {})
      }
      notifyPending = (count) => {
        void registration.events.emit("pending", { count }).catch(() => {})
      }
      notifyFiles = (count) => {
        void registration.events.emit("files", { count }).catch(() => {})
      }
    } catch (error) {
      console.warn("Sensitive protection RPC unavailable:", error)
    }
  }

  const registerManual = async (input: RegisterInput) => {
    const resolved = await resolveProtectedPath(input.file, context.location.directory)
    const info = await stat(resolved)
    if (!info.isFile()) throw new Error("Protected file must be a regular file")
    if (info.size > options.maxContentBytes) throw new Error(`Protected file exceeds the ${options.maxContentBytes} byte limit`)
    if (!input.inspect && input.format === undefined && (input.keys?.length ?? 0) === 0) {
      const existing = hub.catalog().find((item) => item.path === resolved && item.disabled !== true)
      if (existing) {
        return {
          path: resolved,
          format: existing.format,
          keyCount: existing.keyCount,
          valueCount: existing.keyCount,
          alreadyProtected: true,
        }
      }
    }
    const content = await readFile(resolved, "utf8")
    const lines = nonEmptyLines(content)
    let format = input.format
    if (format === undefined) {
      if (isPrivateKey(content)) format = "private-key"
      else if (lines.length === 1) format = "line"
      else {
        throw new ToolError({
          message: [
            "Cannot register this file for manual protection.",
            `Non-empty lines: ${lines.length}.`,
            "Manual protection supports one secret per file.",
            "Split each secret into its own file, or ask the user to add a structured entry with format and keys.",
            "Other multi-line files are rejected.",
          ].join("\n"),
        })
      }
    }
    const keys = input.keys ?? []
    if (isStructuredFormat(format) && keys.length === 0) {
      throw new ToolError({
        message: `format "${format}" requires a non-empty keys array. Use inspect first to list available key paths.`,
      })
    }
    const result = extractContent(content, format, keys, { strict: true })
    if (result.missing.length > 0) {
      throw new ToolError({
        message: [
          "Registration rejected.",
          "Missing keys:",
          ...result.missing.map((key) => `- ${key}`),
          "Available key paths:",
          ...(result.available.length === 0 ? ["- none"] : result.available.map((key) => `- ${key}`)),
        ].join("\n"),
      })
    }
    if (result.values.length === 0) {
      throw new ToolError({
        message: "Registration rejected. No non-empty secret values matched the selected keys.",
      })
    }
    const patterns = patternsForValues(result.values)
    if (patterns.length === 0) {
      throw new ToolError({
        message: "Registration rejected. No protectable secret value was found; values shorter than 6 characters are ignored.",
      })
    }
    const storedKeys = isStructuredFormat(format)
      ? keys
      : format === "private-key"
        ? ["private key body"]
        : format === "line"
          ? ["line"]
          : []
    await hub.addManual({
      path: resolved,
      format,
      keys: storedKeys,
      createdAt: Date.now(),
      ...(input.label === undefined ? {} : { label: input.label }),
      ...(input.role === undefined ? {} : { role: input.role }),
      ...(input.keyID === undefined ? {} : { keyID: input.keyID }),
    }, patterns)
    return {
      path: resolved,
      format,
      keyCount: isStructuredFormat(format) ? keys.length : 1,
      valueCount: result.values.length,
    }
  }

  const inspectFile = async (input: RegisterInput) => {
    const resolved = await resolveProtectedPath(input.file, context.location.directory)
    const info = await stat(resolved)
    if (!info.isFile()) throw new Error("Protected file must be a regular file")
    if (info.size > options.maxContentBytes) throw new Error(`Protected file exceeds the ${options.maxContentBytes} byte limit`)
    const content = await readFile(resolved, "utf8")
    const format = input.format ?? detectFormat(resolved, content)
    if (format === undefined) {
      throw new ToolError({
        message: [
          "Cannot inspect this file.",
          `Non-empty lines: ${nonEmptyLines(content).length}.`,
          "Provide a format (json, yaml, ini, toml, private-key, line) or split the file into one secret per file.",
        ].join("\n"),
      })
    }
    const result = extractContent(content, format, input.keys ?? [], { strict: true })
    return {
      path: resolved,
      format,
      keys: result.available,
      total: result.available.length,
    }
  }

  const disposals: Array<{ dispose: () => Promise<void> }> = []
  try {
    disposeHub = hub.onChange(() => {
      syncManual()
      notifyPending?.(hub.listPending().length)
      emitFiles()
    })
    disposeRegistry = registry.onChange(() => {
      notifyPending?.(hub.listPending().length)
    })

    await manager.start()
    syncManual()

    disposals.push(await context.tool.transform((editor) => {
      editor.add({
        name: REGISTER_TOOL_NAME,
        options: { codemode: false },
        description: "Register a file for local redaction. The file is parsed locally; values are never returned.",
        input: {
          type: "object",
          properties: {
            file: { type: "string", description: "Existing regular file path to protect." },
            format: {
              type: "string",
              enum: ["json", "yaml", "ini", "toml", "private-key", "line"],
              description: "Structured format, private-key, or line. Omit to auto-detect a single-line secret or private key.",
            },
            keys: {
              type: "array",
              items: { type: "string" },
              description: "Key paths to secret fields. Use `.` for nesting and `[]` for every array element. Examples: `auth.token`, `servers[].password`. Every path must match at least one non-empty string; if any path is missing, the whole request is rejected and the error lists every missing path.",
            },
            inspect: {
              type: "boolean",
              description: "List available key paths without values or registration.",
            },
            label: { type: "string", description: "Optional human-readable label." },
            role: { type: "string", enum: ["encrypt-input", "decrypt-output", "manual"] },
            keyID: { type: "string" },
            sessionID: { type: "string" },
            toolCallID: { type: "string" },
          },
          required: ["file"],
          additionalProperties: false,
        },
        execute: async (rawInput: unknown) => {
          const input = rawInput as RegisterInput
          if (typeof input.file !== "string" || !input.file.trim()) throw new Error("file is required")
          if (input.inspect === true) {
            const result = await inspectFile(input)
            return {
              content: JSON.stringify(result, null, 2),
              metadata: { inspected: true, ...result },
            }
          }
          const result = await registerManual(input)
          return {
            content: "Protected file registered.",
            metadata: { registered: true, ...result },
          }
        },
      })
      editor.add({
        name: UNPROTECT_REQUEST_TOOL_NAME,
        options: { codemode: false },
        description: "Request user approval to unprotect a file. Protection is removed only after the user approves in the TUI.",
        input: {
          type: "object",
          properties: {
            file: { type: "string", description: "Protected file path." },
            reason: { type: "string", description: "Short reason shown to the user." },
          },
          required: ["file"],
          additionalProperties: false,
        },
        execute: async (rawInput: unknown, toolContext?: { sessionID?: string }) => {
          const input = rawInput as { file?: unknown; reason?: unknown }
          if (typeof input.file !== "string" || !input.file.trim()) throw new Error("file is required")
          const resolved = await resolveProtectedPath(input.file, context.location.directory)
          const file = hub.catalog().find((item) => item.path === resolved)
          if (!file) throw new Error("This file is not protected")
          const request = await hub.addPending({
            path: resolved,
            source: file.source,
            ...(file.project === undefined ? {} : { project: file.project }),
            ...(toolContext?.sessionID === undefined ? {} : { sessionID: toolContext.sessionID }),
            ...(typeof input.reason === "string" && input.reason.trim() ? { reason: input.reason.trim() } : {}),
          })
          return {
            content: "Unprotect request pending user approval.",
            metadata: { status: "pending", requestID: request.id, file: resolved },
          }
        },
      })
    }))

    disposals.push(await context.tool.hook("execute.before", async (event) => {
      if (event.tool !== "read" && event.tool !== "edit" && event.tool !== "write") return
      const value = inputPath(event.input)
      if (!value) return
      const resolved = await resolveProtectedPath(value, context.location.directory).catch(() => undefined)
      if (!resolved) return
      const entry = registry.get(resolved)
      if (!entry) return
      if (event.tool === "read" && entry.invalid) {
        notify({
          kind: "error",
          source: "parser",
          count: 0,
          ...(entry.label === undefined ? {} : { label: entry.label }),
          file: resolved,
          tool: event.tool,
          sessionID: event.sessionID,
          detail: entry.invalid,
          matches: [{
            file: resolved,
            ...(entry.label === undefined ? {} : { label: entry.label }),
            source: entry.source,
            count: 0,
          }],
        })
        throw new ToolError({
          message: "Blocked: this protected file could not be parsed; read is blocked.",
        })
      }
      if ((event.tool === "write" || event.tool === "edit") && writesRedactionToken(event.input)) {
        throw new ToolError({
          message: `Blocked: ${REDACTION_TOKEN} is a local redaction placeholder. Do not write it back to a file.`,
        })
      }
    }))

    disposals.push(await context.tool.hook("execute.after", async (event) => {
      if (registry.size === 0) return
      const collector = registry.createMatchCollector()
      if (event.status === "error") {
        const error = event.error as { message: string; metadata?: unknown }
        const message = registry.redactValue(error.message, collector)
        const metadata = registry.redactValue(error.metadata, collector)
        const count = message.count + metadata.count
        if (count === 0) return
        if (message.changed) error.message = String(message.value)
        if (metadata.changed) error.metadata = metadata.value
        notify({
          kind: "redacted",
          source: "tool",
          count,
          tool: event.tool,
          sessionID: event.sessionID,
          matches: registry.matchList(collector),
        })
        return
      }
      const result = event.result as {
        content?: unknown
        output?: unknown
        metadata?: unknown
      }
      const content = registry.redactValue(result.content, collector)
      const output = registry.redactValue(result.output, collector)
      const metadata = registry.redactValue(result.metadata, collector)
      const count = content.count + output.count + metadata.count
      if (count === 0) return
      result.content = content.value
      result.output = output.value
      result.metadata = {
        ...(metadata.value && typeof metadata.value === "object" && !Array.isArray(metadata.value) ? metadata.value : {}),
        redacted: true,
        reason: "protected-sensitive-content",
        redactedCount: count,
      }
      notify({
        kind: "redacted",
        source: "tool",
        count,
        tool: event.tool,
        sessionID: event.sessionID,
        matches: registry.matchList(collector),
      })
    }))

    disposals.push(await context.session.hook("context", async (event) => {
      if (registry.size === 0) return
      const collector = registry.createMatchCollector()
      const contextEvent = event as { messages?: unknown; system?: unknown }
      const messages = registry.redactValue(contextEvent.messages, collector)
      const system = registry.redactValue(contextEvent.system, collector)
      const count = messages.count + system.count
      if (count === 0) return
      if (messages.changed) contextEvent.messages = messages.value
      if (system.changed) contextEvent.system = system.value
      notify({
        kind: "redacted",
        source: "context",
        count,
        sessionID: event.sessionID,
        matches: registry.matchList(collector),
      })
    }))

    disposals.push(await context.session.hook("http.request", async (event) => {
      if (registry.size === 0) return
      try {
        const method = event.request.method.toUpperCase()
        if (method === "GET" || method === "HEAD") return
        const body = await event.request.clone().text()
        const collector = registry.createMatchCollector()
        const redacted = registry.redactWithCount(body, collector)
        if (redacted.count === 0) return
        event.request = new Request(event.request.url, {
          method: event.request.method,
          headers: event.request.headers,
          body: redacted.text,
        })
        notify({
          kind: "redacted",
          source: "http",
          count: redacted.count,
          sessionID: event.sessionID,
          matches: registry.matchList(collector),
        })
      } catch {
        // Never break the provider request because optional redaction failed.
      }
    }))

    disposals.push(await context.command.transform((editor) => {
      editor.add({
        name: "protect-sensitive-file",
        description: "Register a single-line secret or private key as protected.",
        execute: async (invocation) => {
          const text = typeof (invocation.prompt as { text?: unknown }).text === "string"
            ? (invocation.prompt as { text: string }).text.trim()
            : ""
          if (!text) throw new Error("A file path is required")
          await registerManual({ file: text, role: "manual" })
        },
      })
      editor.add({
        name: "unprotect-sensitive-file",
        description: "Remove protection from a file.",
        execute: async (invocation) => {
          const text = typeof (invocation.prompt as { text?: unknown }).text === "string"
            ? (invocation.prompt as { text: string }).text.trim()
            : ""
          if (!text) throw new Error("A file path is required")
          const resolved = await resolveProtectedPath(text, context.location.directory)
          await hub.unprotect(resolved, context.location.directory)
        },
      })
    }))
  } catch (error) {
    disposeHub?.()
    disposeRegistry?.()
    await Promise.allSettled(disposals.map((item) => item.dispose()))
    await manager.stop()
    await rpcDispose?.()
    await hub.release()
    console.warn(`Sensitive protection disabled: ${error instanceof Error ? error.message : "setup failed"}`)
    return async () => {}
  }

  return async () => {
    disposeHub?.()
    disposeRegistry?.()
    await Promise.allSettled(disposals.map((item) => item.dispose()))
    await manager.stop()
    await rpcDispose?.()
    await hub.release()
  }
}

function inputPath(input: unknown) {
  if (!input || typeof input !== "object") return
  const value = (input as { path?: unknown }).path
  return typeof value === "string" ? value : undefined
}

function writesRedactionToken(input: unknown) {
  if (!input || typeof input !== "object") return false
  const value = input as { content?: unknown; newString?: unknown }
  return (typeof value.content === "string" && value.content.includes(REDACTION_TOKEN))
    || (typeof value.newString === "string" && value.newString.includes(REDACTION_TOKEN))
}

function safeErrorDetail(error: unknown) {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : ""
  if (/Missing keys/i.test(message)) return message.slice(0, 300)
  if (/maxContentBytes|exceeds/i.test(message)) return "File exceeds the size limit"
  if (/regular file/i.test(message)) return "Path is not a regular file"
  if (/ENOENT|no such file|not found/i.test(message)) return "File is no longer available"
  if (/parse|JSON|YAML|INI|TOML/i.test(message)) return "File could not be parsed"
  return message ? message.slice(0, 300) : "File could not be read or parsed"
}

export default Plugin.define({
  id: "max10240.sensitive-protection",
  setup: setupSensitiveProtection,
})
