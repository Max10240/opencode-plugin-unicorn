import { expect, test } from "bun:test"
import type { Context } from "@opencode/plugin/promise/plugin"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { setupSensitiveProtection } from "../src/index.js"
import type { ProtectionHit } from "../src/rpc.js"

test("emits metadata-only hit events and exposes a merging history", async () => {
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
  let history: (() => Promise<{ hits: ProtectionHit[]; total: number; limit: number }>) | undefined
  let clear: (() => Promise<{ cleared: number }>) | undefined
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
      register: async (_definition: unknown, handlers: any) => {
        history = handlers.history
        clear = handlers.clear
        return {
          events: {
            emit: async (name: string, data: ProtectionHit) => {
              if (name === "hit") hits.push(data)
            },
          },
          dispose: async () => {},
        }
      },
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
    await expect(hooks.get("execute.before")!({
      tool: "read",
      input: { path: blockFile },
      sessionID: "ses_notify",
    })).rejects.toThrow("Blocked")

    const after: any = {
      status: "completed",
      tool: "shell",
      sessionID: "ses_notify",
      result: { content: [{ type: "text", text: "NOTIFY_TOKEN_123" }] },
    }
    await hooks.get("execute.after")!(after)
    await sessions.get("context")!({ sessionID: "ses_notify", messages: [{ content: "NOTIFY_TOKEN_123" }] })
    await sessions.get("context")!({ sessionID: "ses_notify", messages: [{ content: "NOTIFY_TOKEN_123" }] })

    const blocked = hits.find((hit) => hit.kind === "blocked" && hit.source === "read")
    expect(blocked?.tool).toBe("read")
    expect(blocked?.sessionID).toBe("ses_notify")
    expect(blocked?.matches?.[0]).toMatchObject({ count: 1 })
    expect(blocked?.matches?.[0]).not.toHaveProperty("key")
    expect(blocked?.matches?.[0]?.file?.endsWith("block.json")).toBe(true)

    const tool = hits.find((hit) => hit.kind === "redacted" && hit.source === "tool")
    expect(tool?.count).toBe(1)
    expect(tool?.sessionID).toBe("ses_notify")
    expect(tool?.matches?.[0]?.key).toBe("token")
    expect(tool?.matches?.[0]?.file?.endsWith("redact.json")).toBe(true)

    const contexts = hits.filter((hit) => hit.kind === "redacted" && hit.source === "context")
    expect(contexts).toHaveLength(2)
    expect(contexts[1]?.id).toBe(contexts[0]?.id)
    expect(contexts[1]?.occurrences).toBe(2)
    expect(contexts[1]?.matches?.[0]?.key).toBe("token")

    const parser = hits.find((hit) => hit.kind === "error" && hit.source === "parser" && hit.file?.endsWith("bad.json"))
    expect(parser?.detail).toBe("File could not be parsed")
    expect(JSON.stringify(hits)).not.toContain("NOTIFY_TOKEN_123")
    expect(JSON.stringify(hits)).not.toContain("BLOCK_TOKEN_123")

    const snapshot = await history!()
    expect(snapshot.total).toBe(snapshot.hits.length)
    expect(snapshot.limit).toBe(200)
    expect(snapshot.hits.length).toBeGreaterThan(0)
    expect(JSON.stringify(snapshot)).not.toContain("NOTIFY_TOKEN_123")
    expect(JSON.stringify(snapshot)).not.toContain("BLOCK_TOKEN_123")
    expect(await clear!()).toEqual({ cleared: snapshot.hits.length })
    expect((await history!()).hits).toEqual([])
  } finally {
    await cleanup()
    await rm(root, { recursive: true, force: true })
  }
})
