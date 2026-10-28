import { expect, test } from "bun:test"
import type { Context } from "@opencode/plugin/promise/plugin"
import type { Info } from "@opencode/plugin/promise/tool"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { setupSensitiveProtection } from "../src/index.js"

async function fixture(run: (value: {
  root: string
  data: string
  file: string
  options: Record<string, unknown>
}) => Promise<void>) {
  const root = await mkdtemp(path.join(os.tmpdir(), "sensitive-protection-"))
  const data = path.join(root, "data")
  const file = path.join(root, "secret.txt")
  await writeFile(file, "TOPSECRET_LINE_123", { mode: 0o600 })
  try {
    await run({ root, data, file, options: { maxContentBytes: 1024 } })
  } finally { await rm(root, { recursive: true, force: true }) }
}

async function setup(directory: string, data: string, options: Record<string, unknown>) {
  const tools = new Map<string, Info>()
  const hooks = new Map<string, (event: any) => Promise<void>>()
  const sessions = new Map<string, (event: any) => Promise<void>>()
  let command: ((input: any) => Promise<void>) | undefined
  const context = {
    options,
    location: { directory },
    tool: {
      transform: async (callback: (editor: any) => void) => {
        callback({ add: (tool: Info) => { tools.set(tool.name, tool) } })
        return { dispose: async () => {} }
      },
      hook: async (name: string, callback: (event: any) => Promise<void>) => {
        hooks.set(name, callback)
        return { dispose: async () => { hooks.delete(name) } }
      },
    },
    session: {
      hook: async (name: string, callback: (event: any) => Promise<void>) => {
        sessions.set(name, callback)
        return { dispose: async () => { sessions.delete(name) } }
      },
    },
    command: {
      transform: async (callback: (editor: any) => void) => {
        callback({ add: (definition: any) => { command = definition.execute } })
        return { dispose: async () => {} }
      },
    },
  } as unknown as Pick<Context, "options" | "location" | "tool" | "session" | "command">
  const oldData = process.env.XDG_DATA_HOME
  process.env.XDG_DATA_HOME = data
  try {
    const cleanup = await setupSensitiveProtection(context)
    return { tools, hooks, sessions, cleanup, command: () => command }
  } finally {
    if (oldData === undefined) delete process.env.XDG_DATA_HOME
    else process.env.XDG_DATA_HOME = oldData
  }
}

test("registers a file, blocks read, and redacts tool output", async () => {
  await fixture(async ({ root, data, file, options }) => {
    const { tools, hooks, cleanup } = await setup(root, data, options)
    try {
      const register = tools.get("register_sensitive_file")
      expect(register).toBeDefined()
      const result = await register!.execute({ file, role: "manual" }, { sessionID: "s1" } as never) as any
      expect(result.content).toBe("Protected file registered.")
      expect(JSON.stringify(result)).not.toContain("TOPSECRET_LINE_123")

      await expect(hooks.get("execute.before")!({ tool: "read", input: { path: file } })).rejects.toThrow("Blocked")
      await expect(hooks.get("execute.before")!({ tool: "shell", input: { command: `cat ${file}` } })).resolves.toBeUndefined()

      const after: any = {
        status: "completed",
        result: { content: [{ type: "text", text: "prefix TOPSECRET_LINE_123 suffix" }] },
      }
      await hooks.get("execute.after")!(after)
      expect(JSON.stringify(after.result.content)).not.toContain("TOPSECRET_LINE_123")
      expect(JSON.stringify(after.result.content)).toContain("[REDACTED:PROTECTED]")
      expect(after.result.metadata.redacted).toBe(true)

      const failed: any = { status: "error", error: { message: "TOPSECRET_LINE_123" } }
      await hooks.get("execute.after")!(failed)
      expect(failed.error.message).toBe("[REDACTED:PROTECTED]")
    } finally { await cleanup() }
  })
})

test("redacts context messages and outgoing HTTP request bodies", async () => {
  await fixture(async ({ root, data, file, options }) => {
    const { tools, sessions, cleanup } = await setup(root, data, options)
    try {
      await tools.get("register_sensitive_file")!.execute({ file }, { sessionID: "s1" } as never)

      const contextEvent: any = {
        messages: [{ role: "user", content: "prefix TOPSECRET_LINE_123 suffix" }],
        system: [{ type: "text", text: "TOPSECRET_LINE_123" }],
      }
      await sessions.get("context")!(contextEvent)
      expect(JSON.stringify(contextEvent)).not.toContain("TOPSECRET_LINE_123")
      expect(JSON.stringify(contextEvent)).toContain("[REDACTED:PROTECTED]")

      const request = new Request("http://127.0.0.1/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ messages: [{ role: "user", content: "TOPSECRET_LINE_123" }] }),
      })
      const httpEvent: any = { request }
      await sessions.get("http.request")!(httpEvent)
      const body = await httpEvent.request.clone().text()
      expect(body).not.toContain("TOPSECRET_LINE_123")
      expect(body).toContain("[REDACTED:PROTECTED]")
    } finally { await cleanup() }
  })
})

test("persists registrations and supports a per-project escape hatch", async () => {
  await fixture(async ({ root, data, file, options }) => {
    const first = await setup(root, data, options)
    await first.tools.get("register_sensitive_file")!.execute({ file }, { sessionID: "s1" } as never)
    await first.cleanup()
    expect(await readFile(path.join(data, "opencode/sensitive-protection/registry.json"), "utf8")).toContain(file)

    const second = await setup(root, data, options)
    try {
      await expect(second.hooks.get("execute.before")!({ tool: "read", input: { path: file } })).rejects.toThrow("Blocked")
    } finally { await second.cleanup() }

    await import("node:fs/promises").then(({ mkdir }) => mkdir(path.join(root, ".opencode"), { recursive: true }))
    await writeFile(path.join(root, ".opencode", "sensitive-protection.json"), JSON.stringify({ enabled: false }))
    const disabled = await setup(root, data, options)
    try {
      expect(disabled.tools.size).toBe(0)
      expect(disabled.hooks.size).toBe(0)
    } finally { await disabled.cleanup() }
  })
})
