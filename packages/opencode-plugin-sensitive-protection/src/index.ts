import { Plugin } from "@opencode/plugin"
import type { Context } from "@opencode/plugin/promise/plugin"
import { Error as ToolError } from "@opencode/plugin/promise/tool"
import { parseProtectionOptions } from "./options.js"
import { ProtectionRegistry, REDACTION_TOKEN, resolveProtectedPath } from "./registry.js"
import { builtinFiles, customFiles as buildCustomFiles, ManagedFiles } from "./builtins.js"
import { ProtectionHistory } from "./history.js"
import { ProtectionRpc, type ProtectionHit, type ProtectionHistoryResult, type ProtectionMatch } from "./rpc.js"

export { REDACTION_TOKEN } from "./registry.js"

export const REGISTER_TOOL_NAME = "register_sensitive_file"

type PluginContext = Pick<Context, "options" | "location" | "tool" | "session" | "command"> & Partial<Pick<Context, "rpc">>

export async function setupSensitiveProtection(context: PluginContext) {
  let options
  try {
    options = await parseProtectionOptions(context.options, context.location.directory)
  } catch (error) {
    console.warn(`Sensitive protection disabled: ${error instanceof Error ? error.message : "invalid options"}`)
    return async () => {}
  }
  if (!options.enabled) return async () => {}

  const registry = new ProtectionRegistry(options.dataDirectory, options.maxContentBytes)
  await registry.load()
  const history = new ProtectionHistory(options.historyLimit)

  let notifyHit: ((hit: ProtectionHit) => void) | undefined
  let notifyCleared: (() => void) | undefined
  let rpcDispose: (() => Promise<void> | void) | undefined
  if (context.rpc) {
    try {
      const registration = await context.rpc.register(ProtectionRpc, {
        history: async (): Promise<ProtectionHistoryResult> => ({
          hits: history.list(),
          total: history.size,
          limit: options.historyLimit,
        }),
        clear: async () => {
          const cleared = history.clear()
          notifyCleared?.()
          return { cleared }
        },
      })
      rpcDispose = () => registration.dispose()
      notifyHit = (hit) => {
        void registration.events.emit("hit", hit).catch(() => {})
      }
      notifyCleared = () => {
        void registration.events.emit("cleared", {}).catch(() => {})
      }
    } catch (error) {
      console.warn("Sensitive protection RPC unavailable:", error)
    }
  }
  const notify = (hit: Omit<ProtectionHit, "id" | "time" | "firstTime" | "occurrences">) => {
    const recorded = history.record(hit)
    notifyHit?.(recorded)
  }
  for (const error of options.customFileErrors) {
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

  const managedFiles = [
    ...buildCustomFiles({
      files: options.customFiles,
      maxContentBytes: options.maxContentBytes,
      directory: context.location.directory,
      onError: notifyError,
    }),
    ...(options.builtins
      ? builtinFiles({
          disabledGroups: options.disabledBuiltinGroups,
          directory: context.location.directory,
        })
      : []),
  ]
  const manager = new ManagedFiles(registry, managedFiles, options.maxContentBytes, notifyError)

  const registerPath = async (value: string, input: { role?: string; keyID?: string; label?: string } = {}) => {
    const resolved = await resolveProtectedPath(value, context.location.directory)
    const result = await registry.register(resolved, {
      role: input.role ?? "manual",
      keyID: input.keyID,
      label: input.label,
    })
    return { path: resolved, bytes: result.bytes }
  }

  const disposals: Array<{ dispose: () => Promise<void> }> = []
  try {
    await manager.start()
    disposals.push(await context.tool.transform((editor) => {
      editor.add({
        name: REGISTER_TOOL_NAME,
        options: { codemode: false },
        description: "Register an existing file as protected. The file is read locally for redaction; its contents are never output.",
        input: {
          type: "object",
          properties: {
            file: { type: "string", description: "Existing file path to protect." },
            role: { type: "string", enum: ["encrypt-input", "decrypt-output", "manual"] },
            keyID: { type: "string" },
            label: { type: "string" },
            sessionID: { type: "string" },
            toolCallID: { type: "string" },
          },
          required: ["file"],
          additionalProperties: false,
        },
        execute: async (rawInput: unknown) => {
          const input = rawInput as { file?: unknown; role?: unknown; keyID?: unknown; label?: unknown }
          if (typeof input.file !== "string" || !input.file.trim()) throw new Error("file is required")
          const role = input.role === "encrypt-input" || input.role === "decrypt-output" ? input.role : "manual"
          const result = await registerPath(input.file, {
            role,
            ...(typeof input.keyID === "string" ? { keyID: input.keyID } : {}),
            ...(typeof input.label === "string" ? { label: input.label } : {}),
          })
          return {
            content: "Protected file registered.",
            metadata: { registered: true, file: result.path, bytes: result.bytes },
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
      const blocked =
        (event.tool === "read" && options.blockReads && entry.read === "block") ||
        (event.tool === "write" && entry.write === "block") ||
        (event.tool === "edit" && entry.source !== "manual" && entry.read === "block")
      if (!blocked) return
      notify({
        kind: "blocked",
        source: event.tool === "read" ? "read" : "tool",
        count: 1,
        ...(entry.label === undefined ? {} : { label: entry.label }),
        file: resolved,
        tool: event.tool,
        sessionID: event.sessionID,
        matches: [{
          file: resolved,
          ...(entry.label === undefined ? {} : { label: entry.label }),
          source: entry.source,
          count: 1,
        }],
      })
      throw new ToolError({
        message: event.tool === "read"
          ? "Blocked: this file is protected; use an approved viewer instead."
          : "Blocked: this protected file cannot be modified by the agent.",
      })
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

    if (options.redactContext) {
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
    }

    if (options.redactHttp) {
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
    }

    disposals.push(await context.command.transform((editor) => {
      editor.add({
        name: "protect-sensitive-file",
        description: "Register a file as protected from model context.",
        execute: async (invocation) => {
          const text = typeof (invocation.prompt as { text?: unknown }).text === "string"
            ? (invocation.prompt as { text: string }).text.trim()
            : ""
          if (!text) throw new Error("A file path is required")
          await registerPath(text)
        },
      })
    }))
  } catch (error) {
    await Promise.allSettled(disposals.map((item) => item.dispose()))
    await manager.stop()
    await rpcDispose?.()
    console.warn(`Sensitive protection disabled: ${error instanceof Error ? error.message : "setup failed"}`)
    return async () => {}
  }

  return async () => {
    await Promise.allSettled(disposals.map((item) => item.dispose()))
    await manager.stop()
    await rpcDispose?.()
    await registry.flush()
  }
}

function inputPath(input: unknown) {
  if (!input || typeof input !== "object") return
  const value = (input as { path?: unknown }).path
  return typeof value === "string" ? value : undefined
}

function safeErrorDetail(error: unknown) {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : ""
  if (/maxContentBytes|exceeds/i.test(message)) return "File exceeds the size limit"
  if (/regular file/i.test(message)) return "Path is not a regular file"
  if (/ENOENT|no such file|not found/i.test(message)) return "File is no longer available"
  if (/Invalid custom extractor/i.test(message)) return "Custom extractor is invalid"
  if (/parse|JSON|YAML|INI|TOML/i.test(message)) return "File could not be parsed"
  return "File could not be read or parsed"
}

export default Plugin.define({
  id: "max10240.sensitive-protection",
  setup: setupSensitiveProtection,
})
