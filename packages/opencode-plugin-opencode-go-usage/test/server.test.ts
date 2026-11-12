import { expect, test } from "bun:test"
import type { Context } from "@opencode/plugin/promise/plugin"
import type { AccountRef } from "../src/usage.js"
import { setupOpencodeGoUsage } from "../src/index.js"

const work = { type: "credential" as const, id: "cred_work", label: "Work" }
const personal = { type: "credential" as const, id: "cred_personal", label: "Personal" }

function setup(options: Record<string, unknown>) {
  let registered: { definition: any; handlers: any } | undefined
  let disposed = false
  const context = {
    options,
    rpc: {
      register: async (definition: unknown, handlers: unknown) => {
        registered = { definition, handlers }
        return { dispose: async () => { disposed = true } }
      },
    },
    integration: {
      get: async () => ({ data: { connections: [work, personal] } }),
      connection: {
        active: async () => work,
        resolve: async () => ({ type: "key", key: "token" }),
      },
    },
  } as unknown as Context
  return { context, registered: () => registered, disposed: () => disposed }
}

test("registers its RPC by default and exposes all credentials", async () => {
  const harness = setup({})
  const cleanup = await setupOpencodeGoUsage(harness.context)
  const registered = harness.registered()
  expect(registered?.definition.id).toBe("max10240.opencode-go-usage")
  const result = await registered!.handlers.accounts({}) as { accounts: AccountRef[] }
  expect(result.accounts).toEqual([
    { id: "cred_work", label: "Work", active: true },
    { id: "cred_personal", label: "Personal", active: false },
  ])
  await cleanup()
  expect(harness.disposed()).toBe(true)
})

test("does not register when disabled by its own option or feature switch", async () => {
  for (const options of [{ enabled: false }, { features: { opencodeGoUsage: false } }]) {
    const harness = setup(options)
    const cleanup = await setupOpencodeGoUsage(harness.context)
    expect(harness.registered()).toBeUndefined()
    await cleanup()
  }
})

test("accounts returns an empty list when the integration cannot be read", async () => {
  const harness = setup({})
  harness.context.integration.get = async () => {
    throw new Error("unavailable")
  }
  const cleanup = await setupOpencodeGoUsage(harness.context)
  expect(await harness.registered()!.handlers.accounts({})).toEqual({ accounts: [] })
  await cleanup()
})

test("lists usage through every credential without returning tokens", async () => {
  const harness = setup({})
  ;(harness.context.integration.connection as any).resolve = async (connection: any) => ({
    type: "oauth",
    access: `token-${connection.id}`,
    metadata: {
      orgID: connection.id === "cred_work" ? "org_work" : "org_personal",
      orgName: connection.label,
      server: "https://opencode.ai/console",
    },
  })
  const original = globalThis.fetch
  globalThis.fetch = (async (_input: string, init?: RequestInit) => {
    const org = new Headers(init?.headers).get("x-opencode-org-id")
    if (org !== "org_work") return new Response("Forbidden", { status: 403 })
    return Response.json({
      usage: {
        rolling: { status: "ok", percent: 42, resetsAt: "2026-11-13T18:00:00.000Z" },
        weekly: { status: "ok", percent: 18, resetsAt: "2026-11-17T00:00:00.000Z" },
        monthly: { status: "rate-limited", percent: 100, resetsAt: "2026-12-01T00:00:00.000Z" },
      },
    })
  }) as typeof fetch
  const cleanup = await setupOpencodeGoUsage(harness.context)
  try {
    const result = await harness.registered()!.handlers.list({}) as any
    expect(result.accounts.map((account: any) => [account.id, account.state])).toEqual([
      ["cred_work", "ok"],
      ["cred_personal", "not_subscribed"],
    ])
    expect(result.accounts[0].usage.monthly).toEqual({ percent: 100, limited: true, resetsAt: Date.parse("2026-12-01T00:00:00.000Z") })
    expect(JSON.stringify(result)).not.toContain("token-")
  } finally {
    globalThis.fetch = original
    await cleanup()
  }
})
