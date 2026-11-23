import { expect, test } from "bun:test"
import { EventEmitter } from "node:events"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { ensureNpmLogin, expectCommand, extractAuthUrls, authChallenge, runWithAuthLinks } from "../scripts/auth-process.mjs"

const AUTH_ID = "123e4567-e89b-42d3-a456-426614174000"
const AUTH_URL = `https://www.npmjs.com/auth/cli/${AUTH_ID}`

function fakeChild() {
  const child = new EventEmitter() as any
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.kill = () => {}
  return child
}

test("extracts web-auth links from colored npm output", () => {
  const output = [
    "\u001b[32mPress ENTER to open in the browser...\u001b[0m",
    "https://www.npmjs.com/login?next=/login/cli/abc-123",
    "\u001b[36mhttps://www.npmjs.com/auth/cli/def-456\u001b[0m",
  ].join("\n")
  expect(extractAuthUrls(output)).toEqual([
    "https://www.npmjs.com/login?next=/login/cli/abc-123",
    "https://www.npmjs.com/auth/cli/def-456",
  ])
})

test("derives the npm registry done URL from the publish auth link", () => {
  const doneUrl = `https://registry.npmjs.org/-/v1/done?authId=${AUTH_ID}`
  expect(authChallenge(AUTH_URL, "https://registry.npmjs.org/")).toEqual({ id: AUTH_ID, doneUrl })
  expect(authChallenge("https://www.npmjs.com/auth/cli/abc-123", "https://registry.npmjs.org/")).toBeUndefined()
  // npm login uses a different challenge id in the URL; it relies on the local timeout.
  expect(authChallenge(`https://www.npmjs.com/login?next=/login/cli/${AUTH_ID}`, "https://registry.npmjs.org/")).toBeUndefined()
})

test("fails an auth link when the registry reports it is no longer valid", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "auth-expired-"))
  const file = path.join(root, "auth-events.jsonl")
  const child = fakeChild()
  let killed = false
  child.kill = () => { killed = true }
  const pending = runWithAuthLinks(["npm", "publish", "file.tgz"], {
    spawnImpl: () => child,
    authEventFile: file,
    log: () => {},
    fetchImpl: async () => new Response("{}", { status: 404 }),
    authPollMs: 5,
    authExpiryGraceMs: 20,
    authTimeoutMs: 1_000,
  })
  child.stdout.emit("data", Buffer.from(`${AUTH_URL}\n`))
  try {
    await expect(pending).rejects.toThrow("browser verification link expired")
    expect(killed).toBe(true)
    const events = (await readFile(file, "utf8")).trim().split("\n").map((line) => JSON.parse(line))
    expect(events.some((event) => event.type === "expired")).toBe(true)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("fails an auth link locally when the browser window expires", async () => {
  const child = fakeChild()
  let killed = false
  child.kill = () => { killed = true }
  const pending = runWithAuthLinks(["npm", "publish", "file.tgz"], {
    spawnImpl: () => child,
    log: () => {},
    fetchImpl: async () => new Response("{}", { status: 202 }),
    authPollMs: 5,
    authTimeoutMs: 30,
  })
  child.stdout.emit("data", Buffer.from(`${AUTH_URL}\n`))
  await expect(pending).rejects.toThrow("browser verification window expired")
  expect(killed).toBe(true)
})

test("records approval when the registry confirms the link", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "auth-approved-"))
  const file = path.join(root, "auth-events.jsonl")
  const child = fakeChild()
  const pending = runWithAuthLinks(["npm", "publish", "file.tgz"], {
    spawnImpl: () => child,
    authEventFile: file,
    log: () => {},
    fetchImpl: async () => new Response("{}", { status: 200 }),
    authPollMs: 5,
    authTimeoutMs: 1_000,
  })
  try {
    child.stdout.emit("data", Buffer.from(`${AUTH_URL}\n`))
    await Bun.sleep(30)
    child.stdout.emit("data", Buffer.from("__AUTH_EXIT__ 0\n"))
    child.emit("close", 0, null)
    await pending
    const events = (await readFile(file, "utf8")).trim().split("\n").map((line) => JSON.parse(line))
    expect(events.some((event) => event.type === "approved")).toBe(true)
    expect(events.at(-1)).toMatchObject({ type: "resolved" })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("passes every command argument to the expect driver", () => {
  const invocation = expectCommand(["npm", "publish", "it's.tgz"])
  expect(invocation.command).toBe("expect")
  expect(invocation.args[0]).toEndWith("auth-expect.tcl")
  expect(invocation.environment).toMatchObject({ AUTH_ARGC: "3", AUTH_ARG_0: "npm", AUTH_ARG_1: "publish", AUTH_ARG_2: "it's.tgz" })
})

test("prints each auth link once and trusts the reported child status", async () => {
  const child = fakeChild()
  const messages: string[] = []
  const pending = runWithAuthLinks(["npm", "publish", "file.tgz"], {
    spawnImpl: () => child,
    log: (message: string) => messages.push(message),
    timeoutMs: 5_000,
  })
  const url = "https://www.npmjs.com/auth/cli/abc-123"
  child.stdout.emit("data", Buffer.from("https://www.npmjs.com/auth/cli/abc"))
  child.stdout.emit("data", Buffer.from("-123\n"))
  child.stdout.emit("data", Buffer.from(`${url}\n`))
  child.stdout.emit("data", Buffer.from("__AUTH_EXIT__ 0\n"))
  child.emit("close", 0, null)
  await pending
  expect(messages.filter((message) => message.includes(url))).toHaveLength(1)
  expect(messages.join("\n")).toContain("complete authentication")
})

test("records auth and resolution events for a resumable release session", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "auth-events-"))
  const file = path.join(root, "auth-events.jsonl")
  const child = fakeChild()
  const logs: string[] = []
  const pending = runWithAuthLinks(["npm", "publish", "file.tgz"], {
    spawnImpl: () => child,
    authEventFile: file,
    log: (message: string) => logs.push(message),
    timeoutMs: 5_000,
  })
  const url = "https://www.npmjs.com/auth/cli/abc-123"
  child.stdout.emit("data", Buffer.from(`${url}\n`))
  child.stdout.emit("data", Buffer.from("__AUTH_EXIT__ 0\n"))
  child.emit("close", 0, null)
  await pending
  try {
    const events = (await readFile(file, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
    expect(events[0]).toMatchObject({ type: "auth", url })
    expect(events[0].challenge).toBeString()
    expect(events.at(-1)).toMatchObject({ type: "resolved", challenge: events[0].challenge })
    expect(logs.join("\n")).not.toContain(url)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("rejects a failed npm child even when expect exits successfully", async () => {
  const child = fakeChild()
  const pending = runWithAuthLinks(["npm", "publish", "file.tgz"], {
    spawnImpl: () => child,
    log: () => {},
    timeoutMs: 5_000,
  })
  child.stderr.emit("data", Buffer.from("npm error code EOTP\n__AUTH_EXIT__ 1\n"))
  child.emit("close", 0, null)
  await expect(pending).rejects.toThrow("EOTP")
})

test("falls back to a direct command when expect is unavailable", async () => {
  const missing = fakeChild()
  const direct = fakeChild()
  let calls = 0
  const pending = runWithAuthLinks(["npm", "publish", "file.tgz"], {
    spawnImpl: () => (++calls === 1 ? missing : direct),
    log: () => {},
    timeoutMs: 5_000,
  })
  missing.emit("error", Object.assign(new Error("spawn expect ENOENT"), { code: "ENOENT" }))
  missing.emit("close", -2, null)
  direct.emit("close", 0, null)
  await pending
  expect(calls).toBe(2)
})

test("logs in only when whoami fails", async () => {
  const calls: string[][] = []
  const run = async (args: string[]) => {
    calls.push(args)
    if (args[1] === "whoami") throw new Error("E401")
    return ""
  }
  const logins: string[][] = []
  const authRun = async (args: string[]) => { logins.push(args) }
  expect(await ensureNpmLogin({ registry: "https://registry.npmjs.org/", run, authRun, log: () => {} })).toBe(true)
  expect(logins[0]?.slice(0, 3)).toEqual(["npm", "login", "--auth-type=web"])

  const authenticated = async (args: string[]) => { calls.push(args); return "user" }
  expect(await ensureNpmLogin({ registry: "https://registry.npmjs.org/", run: authenticated, authRun, log: () => {} })).toBe(false)
  expect(calls.filter((args) => args[1] === "whoami")).toHaveLength(2)
})
