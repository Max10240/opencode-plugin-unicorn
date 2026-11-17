import { expect, test } from "bun:test"
import type { Context } from "@opencode/plugin/promise/plugin"
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
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
  const home = path.join(root, "home")
  const config = path.join(root, "config")
  const file = path.join(root, "secret.txt")
  await mkdir(home, { recursive: true })
  await mkdir(config, { recursive: true })
  await writeFile(file, "TOPSECRET_LINE_123", { mode: 0o600 })
  const previous = { HOME: process.env.HOME, XDG_DATA_HOME: process.env.XDG_DATA_HOME, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME }
  process.env.HOME = home
  process.env.XDG_DATA_HOME = data
  process.env.XDG_CONFIG_HOME = config
  try {
    await run({ root, data, file, options: { maxContentBytes: 1024, notifications: false } })
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    await rm(root, { recursive: true, force: true })
  }
}

async function setup(directory: string, options: Record<string, unknown>, rpc?: unknown) {
  const tools = new Map<string, any>()
  const hooks = new Map<string, (event: any) => Promise<void>>()
  const sessions = new Map<string, (event: any) => Promise<void>>()
  let command: ((input: any) => Promise<void>) | undefined
  const context = {
    options,
    location: { directory },
    tool: {
      transform: async (callback: (editor: any) => void) => {
        callback({ add: (tool: any) => { tools.set(tool.name, tool) } })
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
    ...(rpc ? { rpc } : {}),
  } as unknown as Pick<Context, "options" | "location" | "tool" | "session" | "command">
  const oldData = process.env.XDG_DATA_HOME
  process.env.XDG_DATA_HOME = options.dataDirectory as string | undefined ?? process.env.XDG_DATA_HOME
  try {
    const cleanup = await setupSensitiveProtection(context)
    return { tools, hooks, sessions, cleanup, command: () => command }
  } finally {
    if (oldData === undefined) delete process.env.XDG_DATA_HOME
    else process.env.XDG_DATA_HOME = oldData
  }
}

function rpcFixture() {
  let service: any
  const events: string[] = []
  const rpc = {
    register: async (_definition: unknown, value: any) => {
      service = value
      return {
        dispose: async () => {},
        events: { emit: async (name: string) => { events.push(name) } },
      }
    },
  }
  return { rpc, service: () => service, events }
}

test("registers a single-line secret and redacts output", async () => {
  await fixture(async ({ root, data, file, options }) => {
    const { tools, hooks, cleanup } = await setup(root, { ...options }, (rpcFixture()).rpc)
    try {
      const register = tools.get("register_sensitive_file")
      expect(register).toBeDefined()
      const result = await register!.execute({ file, role: "manual" }, { sessionID: "s1" } as never) as any
      expect(result.content).toBe("Protected file registered.")
      expect(JSON.stringify(result)).not.toContain("TOPSECRET_LINE_123")

      await expect(hooks.get("execute.before")!({ tool: "read", input: { path: file } })).resolves.toBeUndefined()
      await expect(hooks.get("execute.before")!({ tool: "edit", input: { path: file, newString: "changed" } })).resolves.toBeUndefined()
      await expect(hooks.get("execute.before")!({ tool: "write", input: { path: file, content: "changed" } })).resolves.toBeUndefined()

      const after: any = {
        status: "completed",
        result: { content: [{ type: "text", text: "prefix TOPSECRET_LINE_123 suffix" }] },
      }
      await hooks.get("execute.after")!(after)
      expect(JSON.stringify(after.result.content)).not.toContain("TOPSECRET_LINE_123")
      expect(JSON.stringify(after.result.content)).toContain("[REDACTED:PROTECTED]")
      expect(after.result.metadata.redacted).toBe(true)
    } finally { await cleanup() }
  })
})

test("rejects multi-line manual files and validates structured keys", async () => {
  await fixture(async ({ root, data, file, options }) => {
    const { tools, cleanup } = await setup(root, options, (rpcFixture()).rpc)
    try {
      const register = tools.get("register_sensitive_file")!
      const multi = path.join(root, "multi.txt")
      await writeFile(multi, "LINE_ONE_123\nLINE_TWO_123\n")
      await expect(register.execute({ file: multi }, { sessionID: "s1" } as never)).rejects.toThrow("Split each secret")

      const structured = path.join(root, "settings.json")
      await writeFile(structured, JSON.stringify({ auth: { token: "STRUCTURED_TOKEN_123" }, servers: [{ password: "SERVER_PASSWORD_1" }] }))
      const inspected = await register.execute({ file: structured, format: "json", inspect: true }, { sessionID: "s1" } as never) as any
      expect(JSON.parse(inspected.content).keys).toEqual(expect.arrayContaining(["auth.token", "servers[0].password"]))

      await expect(register.execute({
        file: structured,
        format: "json",
        keys: ["auth.token", "servers[].token", "clients[].secret"],
      }, { sessionID: "s1" } as never)).rejects.toThrow("servers[].token")
      await expect(register.execute({
        file: structured,
        format: "json",
        keys: ["auth.token", "servers[].token", "clients[].secret"],
      }, { sessionID: "s1" } as never)).rejects.toThrow("clients[].secret")

      await register.execute({
        file: structured,
        format: "json",
        keys: ["auth.token", "servers[].password"],
      }, { sessionID: "s1" } as never)
    } finally { await cleanup() }
  })
})

test("persists manual registrations and supports pending unprotect", async () => {
  await fixture(async ({ root, data, file, options }) => {
    const first = rpcFixture()
    const one = await setup(root, options, first.rpc)
    await one.tools.get("register_sensitive_file")!.execute({ file }, { sessionID: "s1" } as never)
    await one.cleanup()
    expect(await readFile(path.join(data, "opencode/sensitive-protection/registry.json"), "utf8")).toContain(file)

    const second = rpcFixture()
    const two = await setup(root, options, second.rpc)
    try {
      await expect(two.hooks.get("execute.before")!({ tool: "read", input: { path: file } })).resolves.toBeUndefined()
      const result = await two.tools.get("request_sensitive_unprotect")!.execute({ file, reason: "test" }, { sessionID: "s1" } as never) as any
      expect(result.metadata.status).toBe("pending")
      const pending = await second.service().pending({})
      expect(pending.count).toBe(1)
      await second.service().resolve({ id: result.metadata.requestID, approve: true })
      const files = await second.service().files({})
      const resolvedFile = await realpath(file)
      expect(files.files.find((entry: any) => entry.path === resolvedFile)).toBeUndefined()
      await expect(two.hooks.get("execute.before")!({ tool: "read", input: { path: file } })).resolves.toBeUndefined()
      const after: any = { status: "completed", result: { content: [{ type: "text", text: "TOPSECRET_LINE_123" }] } }
      await two.hooks.get("execute.after")!(after)
      expect(JSON.stringify(after.result)).not.toContain("[REDACTED:PROTECTED]")
    } finally { await two.cleanup() }
  })
})

test("blocks writing redaction placeholders back to files", async () => {
  await fixture(async ({ root, data, file, options }) => {
    const { tools, hooks, cleanup } = await setup(root, options, (rpcFixture()).rpc)
    try {
      await tools.get("register_sensitive_file")!.execute({ file }, { sessionID: "s1" } as never)
      await expect(hooks.get("execute.before")!({
        tool: "write",
        input: { path: file, content: "[REDACTED:PROTECTED]" },
      })).rejects.toThrow("Do not write")
      await expect(hooks.get("execute.before")!({
        tool: "edit",
        input: { path: file, oldString: "TOPSECRET_LINE_123", newString: "[REDACTED:PROTECTED]" },
      })).rejects.toThrow("Do not write")
    } finally { await cleanup() }
  })
})

test("exposes active files with source metadata and no secret values", async () => {
  await fixture(async ({ root, data, file, options }) => {
    const rpc = rpcFixture()
    const { tools, cleanup } = await setup(root, options, rpc.rpc)
    try {
      await tools.get("register_sensitive_file")!.execute({ file, role: "manual", label: "manual secret" }, { sessionID: "s1" } as never)
      const result = await rpc.service().files({})
      expect(result.total).toBe(1)
      expect(result.files[0]).toMatchObject({
        path: await realpath(file),
        source: "manual",
        label: "manual secret",
      })
      expect(result.files[0].keys).toEqual(["line"])
      expect(JSON.stringify(result)).not.toContain("TOPSECRET_LINE_123")
    } finally { await cleanup() }
  })
})
