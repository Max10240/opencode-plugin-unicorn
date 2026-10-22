import { expect, test } from "bun:test"
import type { Context } from "@opencode/plugin/promise/plugin"
import type { Info, ToolContext, ToolEditor } from "@opencode/plugin/promise/tool"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import unicorn from "../src/index.js"

test("Unicorn honors both its feature gate and show-img's own nested options on the server", async () => {
  for (const feature of [false, true]) {
    for (const nested of [false, true]) {
      let tools = 0
      let rpc = 0
      const context = {
        options: {
          features: { recommendedOpencodeConfig: false, sendMessageAcrossSessions: false, imageGen: false, showImg: feature },
          showImg: { features: { showImg: nested } },
        },
        storage: {},
        tool: { transform: async () => { tools++; return { dispose: async () => { tools-- } } } },
        rpc: { register: async () => { rpc++; return { dispose: async () => { rpc-- } } } },
      } as unknown as Context
      const cleanup = await unicorn.setup(context)
      expect(tools).toBe(Number(feature && nested))
      expect(rpc).toBe(Number(feature && nested))
      if (cleanup) await cleanup()
      expect(tools).toBe(0)
      expect(rpc).toBe(0)
    }
  }
})

test("the assembled image tool uses nested model, URL and credentials without leaking flat or sibling options", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "unicorn-options-"))
  let requests = 0
  let registered: Info | undefined
  let disposed = false
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    requests++
    expect(new URL(request.url).pathname).toBe("/nested/images/generations")
    expect(request.headers.get("authorization")).toBe("Bearer synthetic-nested-key")
    expect((await request.json() as { model: string }).model).toBe("nested-model")
    return Response.json({ data: [{ b64_json: "UE5H" }] })
  } })
  const imageGen = Object.freeze({ model: "nested-provider/nested-model", baseURL: `${server.url.origin}/nested`, integrationID: "nested-auth" })
  const context = Object.freeze({
    options: {
      features: { recommendedOpencodeConfig: false, sendMessageAcrossSessions: false, imageGen: true, showImg: false }, imageGen,
      model: "flat/model", baseURL: `${server.url.origin}/flat`, integrationID: "flat-auth", promptSearch: { model: "sibling/model" },
    },
    session: { get: async () => ({ model: { providerID: "chat-provider", id: "chat-model" }, location: { directory } }) },
    model: { list: async () => ({ data: [] }) },
    provider: { get: async ({ providerID }: { providerID: string }) => {
      expect(providerID).toBe("nested-provider")
      return { data: { activation: "enabled", package: "@opencode/ai/providers/openai-compatible", integrationID: "provider-auth", settings: { baseURL: `${server.url.origin}/provider`, apiKey: "shadowed-key" } } }
    } },
    integration: { connection: {
      active: async (id: string) => { expect(id).toBe("nested-auth"); return { type: "credential", id: "synthetic" } },
      resolve: async () => ({ type: "key", key: "synthetic-nested-key" }),
    } },
    tool: {
      list: async () => [],
      transform: async (callback: (editor: ToolEditor) => void) => {
        callback({ add: (tool: Info) => { registered = tool } } as ToolEditor)
        return { dispose: async () => { disposed = true } }
      },
    },
  }) as unknown as Context
  let cleanup: Awaited<ReturnType<typeof unicorn.setup>> = undefined
  try {
    cleanup = await unicorn.setup(context)
    expect(registered?.name).toBe("image_gen")
    const result = await registered!.execute({ prompt: "proof", out: "proof.png" }, { sessionID: "synthetic-session", progress: async () => {} } as unknown as ToolContext)
    expect(await readFile(path.join(directory, "proof.png"), "utf8")).toBe("PNG")
    expect(requests).toBe(1)
    expect(JSON.stringify(result)).not.toContain("synthetic-nested-key")
    expect(context.options.imageGen).toBe(imageGen)
  } finally {
    try { if (cleanup) await cleanup() }
    finally { server.stop(true); await rm(directory, { recursive: true, force: true }) }
  }
  expect(disposed).toBe(true)
})
