import { expect, test } from "bun:test"
import type { Context } from "@opencode/plugin/promise/plugin"
import { credentialSettings, resolveCredential } from "../src/credential.js"

test("no active connection is allowed without consulting another provider or auth file", async () => {
  const calls: string[] = []
  const context = { integration: { connection: {
    active: async (id: string) => { calls.push(id); return undefined },
    resolve: async () => { throw new Error("must not resolve") },
  } } } as unknown as Pick<Context, "integration">
  expect(await resolveCredential(context, "custom-integration")).toBeUndefined()
  expect(calls).toEqual(["custom-integration"])
})

test("active key, environment, and OAuth connections are resolved by the same Core API", async () => {
  for (const kind of ["key", "env", "oauth"] as const) {
    const connection = kind === "env" ? { type: "env", name: "CUSTOM_KEY" } : { type: "credential", id: "fixture" }
    let calls = 0
    const context = { integration: { connection: {
      active: async () => connection,
      resolve: async (selected: unknown) => {
        expect(selected).toBe(connection)
        calls++
        return kind === "oauth" ? { type: "oauth", access: "fresh-oauth", metadata: { accountID: "fixture" } }
          : { type: "key", key: "resolved-key", configuration: { region: "test" } }
      },
    } } } as unknown as Pick<Context, "integration">
    const result = await resolveCredential(context, "integration")
    expect(result?.value).toBe(kind === "oauth" ? "fresh-oauth" : "resolved-key")
    expect(result?.source).toBe(kind === "env" ? "environment" : kind)
    expect(calls).toBe(1)
  }
})

test("credential resolution and refresh failures propagate without a weaker auth fallback", async () => {
  const context = { integration: { connection: {
    active: async () => ({ type: "credential", id: "fixture" }),
    resolve: async () => { throw new Error("refresh denied") },
  } } } as unknown as Pick<Context, "integration">
  await expect(resolveCredential(context, "integration")).rejects.toThrow("refresh denied")
})

test("key metadata overlays body while OAuth metadata stays out of the payload", () => {
  const settings = { apiKey: "", baseURL: "original" }
  const body = { nested: { original: true }, keep: "user" }
  const key = credentialSettings(settings, body, { value: "key", source: "key", metadata: { nested: { account: true } }, configuration: { baseURL: "connection" } })
  expect(key.settings.baseURL).toBe("connection")
  expect(key.settings).not.toHaveProperty("apiKey")
  expect(key.body).toEqual({ nested: { original: true, account: true }, keep: "user" })
  const oauth = credentialSettings(settings, body, { value: "oauth", source: "oauth", metadata: { accountID: "account" } })
  expect(oauth.body).toEqual(body)
  expect(settings.apiKey).toBe("")
  expect(body).toEqual({ nested: { original: true }, keep: "user" })
})
