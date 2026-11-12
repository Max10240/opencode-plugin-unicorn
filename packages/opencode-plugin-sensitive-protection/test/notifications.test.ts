import { expect, test } from "bun:test"
import type { Context } from "@opencode/plugin/promise/plugin"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { setupSensitiveProtection } from "../src/index.js"
import type { ProtectionHit } from "../src/rpc.js"

test("emits metadata-only hit events for blocked reads and redaction", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sensitive-notify-"))
  const redactFile = path.join(root, "redact.json")
  const blockFile = path.join(root, "block.json")
  const badFile = path.join(root, "bad.json")
  await writeFile(redactFile, JSON.stringify({ token: "NOTIFY_TOKEN_123" }))
  await writeFile(blockFile, JSON.stringify({ token: "BLOCK_TOKEN_123" }))
  await writeFile(badFile, "{not-json")

  const hits: ProtectionHit[] = []
  const hooks = new Map<string, (event: any) => Promise<void>>()
  const sessions = new Map<string, (event: any) => Promise<void>>()
  const context = {
    options: {
      builtins: false,
      notifications: true,
      customFiles: [
        { path: redactFile, format: "json", fields: ["token"] },
        { path: blockFile, format: "json", fields: ["token"], read: "block" },
        { path: badFile, format: "json", fields: ["token"] },
      ],
    },
    location: { directory: root },
    rpc: {
      register: async () => ({
        events: {
          emit: async (name: string, data: ProtectionHit) => {
            if (name === "hit") hits.push(data)
          },
        },
        dispose: async () => {},
      }),
    },
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
    session: {
      hook: async (name: string, callback: (event: any) => Promise<void>) => {
        sessions.set(name, callback)
        return { dispose: async () => { sessions.delete(name) } }
      },
    },
    command: { transform: async () => ({ dispose: async () => {} }) },
  } as unknown as Pick<Context, "options" | "location" | "tool" | "session" | "command" | "rpc">
  const cleanup = await setupSensitiveProtection(context)
  try {
    await expect(hooks.get("execute.before")!({ tool: "read", input: { path: blockFile } })).rejects.toThrow("Blocked")
    const after: any = { status: "completed", tool: "shell", result: { content: [{ type: "text", text: "NOTIFY_TOKEN_123" }] } }
    await hooks.get("execute.after")!(after)
    await sessions.get("context")!({ messages: [{ content: "NOTIFY_TOKEN_123" }] })

    expect(hits.some((hit) => hit.kind === "blocked" && hit.source === "read" && hit.tool === "read")).toBe(true)
    expect(hits.some((hit) => hit.kind === "redacted" && hit.source === "tool" && hit.count === 1)).toBe(true)
    expect(hits.some((hit) => hit.kind === "redacted" && hit.source === "context" && hit.count === 1)).toBe(true)
    expect(hits.some((hit) => hit.kind === "error" && hit.source === "parser" && hit.file?.endsWith("bad.json"))).toBe(true)
    expect(JSON.stringify(hits)).not.toContain("NOTIFY_TOKEN_123")
    expect(JSON.stringify(hits)).not.toContain("BLOCK_TOKEN_123")
  } finally {
    await cleanup()
    await rm(root, { recursive: true, force: true })
  }
})
