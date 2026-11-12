import { expect, test } from "bun:test"
import { normalizeServer, listAccountRefs, listAccountUsage, parseUsage, type ConnectionLike, type CredentialLike, type UsageSource } from "../src/usage.js"

const work = { type: "credential" as const, id: "cred_work", label: "Work" }
const personal = { type: "credential" as const, id: "cred_personal", label: "Personal" }
const environment = { type: "env" as const, name: "OPENCODE_KEY" }

const oauth = (orgID: string, server = "https://opencode.ai/console"): CredentialLike => ({
  type: "oauth",
  access: `token-${orgID}`,
  metadata: { orgID, orgName: orgID === "org_work" ? "Work" : "Personal", server },
})

function source(input: {
  connections?: ConnectionLike[]
  active?: ConnectionLike
  resolve?: (connection: ConnectionLike) => Promise<CredentialLike | undefined>
} = {}): UsageSource {
  const connections = input.connections ?? [work, personal]
  return {
    get: async () => ({ connections }),
    active: async () => input.active ?? connections[0],
    resolve:
      input.resolve ??
      (async (connection) =>
        connection.type === "credential"
          ? oauth(connection.id === "cred_work" ? "org_work" : "org_personal")
          : undefined),
  }
}

function usageBody(rolling = 42, weekly = 18, monthly = 7) {
  return {
    usage: {
      rolling: { status: "ok", percent: rolling, resetsAt: "2026-11-13T18:00:00.000Z" },
      weekly: { status: "ok", percent: weekly, resetsAt: "2026-11-17T00:00:00.000Z" },
      monthly: { status: "rate-limited", percent: monthly, resetsAt: "2026-12-01T00:00:00.000Z" },
    },
  }
}

test("lists every credential, marks the active one, and ignores environment credentials", async () => {
  expect(await listAccountRefs(source({ connections: [environment, personal, work], active: work }))).toEqual([
    { id: "cred_work", label: "Work", active: true },
    { id: "cred_personal", label: "Personal", active: false },
  ])
})

test("queries every credential independently and includes inactive accounts", async () => {
  const requests: Array<{ url: string; headers: Headers }> = []
  const accounts = await listAccountUsage(source({ active: work }), {
    fetch: async (url, init) => {
      requests.push({ url, headers: new Headers(init?.headers) })
      const org = new Headers(init?.headers).get("x-opencode-org-id")
      return org === "org_work" ? Response.json(usageBody()) : new Response("Forbidden", { status: 403 })
    },
  })

  expect(accounts.map((account) => [account.id, account.active, account.state])).toEqual([
    ["cred_work", true, "ok"],
    ["cred_personal", false, "not_subscribed"],
  ])
  expect(accounts[0]).toMatchObject({
    workspace: { id: "org_work", name: "Work" },
    usage: {
      rolling: { percent: 42, limited: false },
      weekly: { percent: 18, limited: false },
      monthly: { percent: 7, limited: true },
    },
  })
  expect(requests).toHaveLength(2)
  expect(requests[0]).toMatchObject({
    url: "https://opencode.ai/zen/go/v1/usage",
  })
  expect(requests[0]!.headers.get("authorization")).toBe("Bearer token-org_work")
  expect(requests[0]!.headers.get("x-opencode-org-id")).toBe("org_work")
  expect(JSON.stringify(accounts)).not.toContain("token-org_work")
})

test("isolates one failed account from the rest", async () => {
  const accounts = await listAccountUsage(
    source({
      active: work,
      resolve: async (connection) => {
        if (connection.type !== "credential") return undefined
        if (connection.id === "cred_personal") throw new Error("refresh failed")
        return oauth("org_work")
      },
    }),
    { fetch: async () => Response.json(usageBody()) },
  )

  expect(accounts[0]).toMatchObject({ id: "cred_work", state: "ok" })
  expect(accounts[1]).toMatchObject({ id: "cred_personal", state: "needs_auth" })
  expect(accounts[1]?.error).toContain("/connect")
})

test("maps authentication, unsupported credentials, and network failures", async () => {
  const unauthenticated = await listAccountUsage(source(), {
    fetch: async () => new Response("Unauthorized", { status: 401 }),
  })
  expect(unauthenticated.every((account) => account.state === "needs_auth")).toBe(true)

  const unsupported = await listAccountUsage(
    source({
      resolve: async () => ({ type: "key", key: "service-key", metadata: {} }),
    }),
    { fetch: async () => Response.json(usageBody()) },
  )
  expect(unsupported.every((account) => account.state === "unsupported")).toBe(true)

  const unavailable = await listAccountUsage(source(), {
    fetch: async () => {
      throw new Error("offline")
    },
  })
  expect(unavailable.every((account) => account.state === "error" && account.error === "Could not reach OpenCode Go usage.")).toBe(true)
})

test("normalizes the retired Console host and validates malformed responses", async () => {
  let requested = ""
  await listAccountUsage(
    source({
      connections: [work],
      active: work,
      resolve: async () => oauth("org_work", "https://console.opencode.ai"),
    }),
    {
      fetch: async (url) => {
        requested = url
        return Response.json(usageBody())
      },
    },
  )
  expect(requested).toBe("https://opencode.ai/zen/go/v1/usage")
  expect(normalizeServer("https://console.opencode.ai/")).toBe("https://opencode.ai/console/")

  const invalid = usageBody()
  invalid.usage.rolling = { status: "ok", percent: "42", resetsAt: "soon" } as never
  expect(() => parseUsage(invalid)).toThrow()
  const clamped = usageBody(101)
  expect(parseUsage(clamped).rolling.percent).toBe(100)
})

test("returns no accounts when the integration is absent", async () => {
  expect(await listAccountRefs({ get: async () => undefined, active: async () => undefined, resolve: async () => undefined })).toEqual([])
  expect(await listAccountUsage({ get: async () => undefined, active: async () => undefined, resolve: async () => undefined })).toEqual([])
})
