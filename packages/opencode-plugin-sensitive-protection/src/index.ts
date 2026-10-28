import { Plugin } from "@opencode/plugin"
import type { Context } from "@opencode/plugin/promise/plugin"
import { Error as ToolError } from "@opencode/plugin/promise/tool"
import { parseProtectionOptions } from "./options.js"
import { ProtectionRegistry, REDACTION_TOKEN, resolveProtectedPath } from "./registry.js"

export { REDACTION_TOKEN } from "./registry.js"

export const REGISTER_TOOL_NAME = "register_sensitive_file"

type PluginContext = Pick<Context, "options" | "location" | "tool" | "session" | "command">

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

    if (options.blockReads) {
      disposals.push(await context.tool.hook("execute.before", async (event) => {
        if (event.tool !== "read" || !event.input || typeof event.input !== "object") return
        const value = (event.input as { path?: unknown }).path
        if (typeof value !== "string") return
        const resolved = await resolveProtectedPath(value, context.location.directory).catch(() => undefined)
        if (resolved && registry.has(resolved)) {
          throw new ToolError({ message: "Blocked: this file is protected; use an approved viewer instead." })
        }
      }))
    }

    disposals.push(await context.tool.hook("execute.after", async (event) => {
      if (registry.size === 0) return
      if (event.status === "error") {
        const error = event.error as { message: string; metadata?: unknown }
        const message = registry.redactValue(error.message)
        const metadata = registry.redactValue(error.metadata)
        if (!message.changed && !metadata.changed) return
        if (message.changed) error.message = String(message.value)
        if (metadata.changed) error.metadata = metadata.value
        return
      }
      const result = event.result as {
        content?: unknown
        output?: unknown
        metadata?: unknown
      }
      const content = registry.redactValue(result.content)
      const output = registry.redactValue(result.output)
      const metadata = registry.redactValue(result.metadata)
      if (!content.changed && !output.changed && !metadata.changed) return
      result.content = content.value
      result.output = output.value
      result.metadata = {
        ...(metadata.value && typeof metadata.value === "object" && !Array.isArray(metadata.value) ? metadata.value : {}),
        redacted: true,
        reason: "protected-sensitive-content",
      }
    }))

    if (options.redactContext) {
      disposals.push(await context.session.hook("context", async (event) => {
        if (registry.size === 0) return
        const messages = registry.redactValue((event as { messages?: unknown }).messages)
        const system = registry.redactValue((event as { system?: unknown }).system)
        if (messages.changed) (event as { messages: unknown }).messages = messages.value
        if (system.changed) (event as { system: unknown }).system = system.value
      }))
    }

    if (options.redactHttp) {
      disposals.push(await context.session.hook("http.request", async (event) => {
        if (registry.size === 0) return
        try {
          const method = event.request.method.toUpperCase()
          if (method === "GET" || method === "HEAD") return
          const body = await event.request.clone().text()
          const redacted = registry.redact(body)
          if (redacted === body) return
          event.request = new Request(event.request.url, {
            method: event.request.method,
            headers: event.request.headers,
            body: redacted,
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
    console.warn(`Sensitive protection disabled: ${error instanceof Error ? error.message : "setup failed"}`)
    return async () => {}
  }

  return async () => {
    await Promise.allSettled(disposals.map((item) => item.dispose()))
    await registry.flush()
  }
}

export default Plugin.define({
  id: "max10240.sensitive-protection",
  setup: setupSensitiveProtection,
})
