import { expect, test } from "bun:test"
import { EventEmitter } from "node:events"
import { ensureNpmLogin, expectCommand, extractAuthUrls, runWithAuthLinks } from "../scripts/auth-process.mjs"

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
