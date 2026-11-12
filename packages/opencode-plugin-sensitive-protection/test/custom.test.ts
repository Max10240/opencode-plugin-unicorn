import { expect, test } from "bun:test"
import type { Context } from "@opencode/plugin/promise/plugin"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { setupSensitiveProtection } from "../src/index.js"

async function setup(directory: string, options: Record<string, unknown>) {
  const hooks = new Map<string, (event: any) => Promise<void>>()
  const context = {
    options,
    location: { directory },
    tool: {
      transform: async (callback: (editor: any) => void) => {
        callback({ add: () => {} })
        return { dispose: async () => {} }
      },
      hook: async (name: string, callback: (event: any) => Promise<void>) => {
        hooks.set(name, callback)
        return { dispose: async () => { hooks.delete(name) } }
      },
    },
    session: { hook: async () => ({ dispose: async () => {} }) },
    command: { transform: async () => ({ dispose: async () => {} }) },
  } as unknown as Pick<Context, "options" | "location" | "tool" | "session" | "command">
  const cleanup = await setupSensitiveProtection(context)
  return { hooks, cleanup }
}

async function redact(hooks: Map<string, (event: any) => Promise<void>>, text: string) {
  const event: any = { status: "completed", tool: "shell", result: { content: [{ type: "text", text }] } }
  await hooks.get("execute.after")!(event)
  return event.result.content[0].text as string
}

test("custom declarative files extract only declared fields", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sensitive-custom-"))
  const file = path.join(root, "settings.json")
  await writeFile(file, JSON.stringify({ apiKey: "CUSTOM_API_KEY_123", safe: "ordinary-value" }))
  const { hooks, cleanup } = await setup(root, {
    builtins: false,
    notifications: false,
    customFiles: [{ path: file, format: "json", fields: ["apiKey"] }],
  })
  try {
    expect(await redact(hooks, "CUSTOM_API_KEY_123 ordinary-value")).toBe("[REDACTED:PROTECTED] ordinary-value")
    await expect(hooks.get("execute.before")!({ tool: "write", input: { path: file } })).rejects.toThrow("Blocked")
  } finally {
    await cleanup()
    await rm(root, { recursive: true, force: true })
  }
})

test("custom INI fields match registry-scoped npmrc keys", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sensitive-custom-ini-"))
  const file = path.join(root, ".npmrc")
  await writeFile(file, "//registry.npmjs.org/:_authToken=CUSTOM_NPM_TOKEN_123\n")
  const { hooks, cleanup } = await setup(root, {
    builtins: false,
    notifications: false,
    customFiles: [{ path: file, format: "ini", fields: ["_authToken"] }],
  })
  try {
    expect(await redact(hooks, "CUSTOM_NPM_TOKEN_123")).toBe("[REDACTED:PROTECTED]")
  } finally {
    await cleanup()
    await rm(root, { recursive: true, force: true })
  }
})

test("custom extractor can read the file through context.readFile", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sensitive-extractor-"))
  const file = path.join(root, "secrets.txt")
  await writeFile(file, "SECRET=EXTRACTOR_TOKEN_123\nSAFE=ordinary\n")
  const { hooks, cleanup } = await setup(root, {
    builtins: false,
    allowCustomExtractors: true,
    notifications: false,
    customFiles: [{
      path: file,
      extractor: "return context.readFile().split('\\n').filter((line) => line.startsWith('SECRET=')).map((line) => line.slice(7))",
    }],
  })
  try {
    expect(await redact(hooks, "EXTRACTOR_TOKEN_123 ordinary")).toBe("[REDACTED:PROTECTED] ordinary")
  } finally {
    await cleanup()
    await rm(root, { recursive: true, force: true })
  }
})

test("custom extractors require an explicit opt-in", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sensitive-extractor-disabled-"))
  const file = path.join(root, "secrets.txt")
  await writeFile(file, "SECRET=EXTRACTOR_TOKEN_123\n")
  const { hooks, cleanup } = await setup(root, {
    builtins: false,
    notifications: false,
    customFiles: [{ path: file, extractor: "return ['EXTRACTOR_TOKEN_123']" }],
  })
  try {
    expect(await redact(hooks, "EXTRACTOR_TOKEN_123")).toBe("EXTRACTOR_TOKEN_123")
  } finally {
    await cleanup()
    await rm(root, { recursive: true, force: true })
  }
})
