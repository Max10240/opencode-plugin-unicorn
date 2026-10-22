import { expect, test } from "bun:test"
import type { Context } from "@opencode/plugin/promise/plugin"
import type { Info, ToolContext, ToolEditor } from "@opencode/plugin/promise/tool"
import { access, mkdtemp, readFile, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { normalizeImageInput, setupImageGen } from "../src/index.js"

async function fixture(directory: string, baseURL: string, options = {}, oauth = false) {
  let registered: Info | undefined
  let disposed = false
  const context = {
    options,
    session: { get: async () => ({ model: null, location: { directory } }) },
    model: { list: async () => ({ data: [] }) },
    provider: { get: async () => ({ data: { integrationID: "fixture-auth", activation: "enabled", package: "@opencode/ai/providers/openai", settings: { baseURL: `${baseURL}/provider`, apiKey: "shadowed" }, headers: { "chatgpt-account-id": "synthetic-account" }, body: { nested: { base: true } } } }) },
    integration: { connection: {
      active: async (id: string) => { expect(id).toBe("fixture-auth"); return { type: "credential", id: "fixture" } },
      resolve: async () => oauth ? { type: "oauth", access: "synthetic-oauth", metadata: { accountID: "synthetic-account" } }
        : { type: "key", key: "synthetic-selected-key", metadata: { nested: { connection: true } }, configuration: { baseURL: `${baseURL}/connection`, organization: "synthetic-org" } },
    } },
    tool: { list: async () => [], transform: async (callback: (editor: ToolEditor) => void) => {
      callback({ add: (tool: Info) => { registered = tool } } as ToolEditor)
      return { dispose: async () => { disposed = true } }
    } },
  } as unknown as Context
  const dispose = await setupImageGen(context)
  const tool = { sessionID: "synthetic-session", progress: async () => {} } as unknown as ToolContext
  return { input: registered!.input, execute: (signal?: AbortSignal, input = {}) => registered!.execute({ prompt: "proof", out: "proof.png", ...input }, { ...tool, ...(signal ? { signal } : {}) }), dispose, disposed: () => disposed }
}

test("null optional fields are omitted without changing required fields or valid values", () => {
  expect(normalizeImageInput({ prompt: "proof", out: "proof.png", model: null, quality: null, size: null, images: null })).toEqual({ prompt: "proof", out: "proof.png" })
  const input = { prompt: "proof", out: "proof.png", model: "openai/image", quality: "high" as const, size: "1024x1024", images: ["reference.png"] }
  expect(normalizeImageInput(input)).toEqual(input)
  for (const field of ["model", "quality", "size", "images"]) {
    const normalized: Record<string, unknown> = normalizeImageInput({ ...input, [field]: null })
    expect(normalized).toEqual(Object.fromEntries(Object.entries(input).filter(([key]) => key !== field)))
  }
})

test("the tool schema accepts null for every optional field and null never reaches the image API", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "image-gen-null-"))
  let requests = 0
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    requests++
    const body = await request.json() as Record<string, unknown>
    for (const field of ["model", "quality", "size", "images"]) expect(body[field]).not.toBeNull()
    return Response.json({ data: [{ b64_json: "UE5H" }] })
  } })
  try {
    const registered = await fixture(directory, server.url.origin)
    try {
      const schema = registered.input as any
      expect(schema.required).toEqual(["prompt", "out"])
      expect(schema.additionalProperties).toBe(false)
      for (const field of ["model", "quality", "size", "images"]) expect(schema.properties[field].type).toContain("null")
      expect(schema.properties.quality.enum).toContain(null)
      expect(schema.properties.prompt.type).toBe("string")
      expect(schema.properties.out.type).toBe("string")
      await registered.execute(undefined, { model: null, quality: null, size: null, images: null })
      expect(requests).toBe(1)
      expect(await readFile(path.join(directory, "proof.png"), "utf8")).toBe("PNG")
    } finally { await registered.dispose() }
  } finally { server.stop(true); await rm(directory, { recursive: true, force: true }) }
})

test.each([false, true])("the registered tool honors key configuration and explicit URL priority (override=%s)", async (override) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "image-gen-setup-"))
  let requests = 0
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    requests++
    expect(new URL(request.url).pathname).toBe(`${override ? "/explicit" : "/connection"}/images/generations`)
    expect(request.headers.get("authorization")).toBe("Bearer synthetic-selected-key")
    expect(request.headers.get("openai-organization")).toBe("synthetic-org")
    expect(request.headers.get("x-opencode-session-id")).toBe("synthetic-session")
    expect((await request.json() as { nested: unknown }).nested).toEqual({ base: true, connection: true })
    return Response.json({ data: [{ b64_json: "UE5H" }] })
  } })
  try {
    const registered = await fixture(directory, server.url.origin, override ? { baseURL: `${server.url.origin}/explicit` } : {})
    const result = await registered.execute() // Older runtimes omit signal.
    expect(result.content).toContain("proof.png")
    expect(await readFile(path.join(directory, "proof.png"), "utf8")).toBe("PNG")
    expect(JSON.stringify(result)).not.toContain("synthetic-selected-key")
    expect(requests).toBe(1)
    await registered.dispose()
    expect(registered.disposed()).toBe(true)
  } finally { server.stop(true); await rm(directory, { recursive: true, force: true }) }
})

test("OAuth uses the selected token and resolved account header without leaking metadata into the image body", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "image-gen-oauth-"))
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    expect(request.headers.get("authorization")).toBe("Bearer synthetic-oauth")
    expect(request.headers.get("chatgpt-account-id")).toBe("synthetic-account")
    expect(await request.json()).not.toHaveProperty("accountID")
    return Response.json({ data: [{ b64_json: "UE5H" }] })
  } })
  try {
    const registered = await fixture(directory, server.url.origin, {}, true)
    const result = await registered.execute()
    expect(result.metadata?.credentialSource).toBe("oauth")
    expect(JSON.stringify(result)).not.toContain("synthetic-oauth")
    await registered.dispose()
  } finally { server.stop(true); await rm(directory, { recursive: true, force: true }) }
})

test("the registered tool forwards runtime cancellation and never saves an aborted image", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "image-gen-cancel-"))
  let requests = 0
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { requests++; return new Response("must not call") } })
  try {
    const registered = await fixture(directory, server.url.origin)
    await expect(registered.execute(AbortSignal.abort())).rejects.toThrow()
    expect(requests).toBe(0)
    await expect(access(path.join(directory, "proof.png"))).rejects.toThrow()
    await registered.dispose()
  } finally { server.stop(true); await rm(directory, { recursive: true, force: true }) }
})
