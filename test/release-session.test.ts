import { expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {
  buildResumeCommand,
  createSession,
  loadSession,
  parseResumeArgs,
  pendingAuthEvent,
  readDone,
  watchSession,
} from "../scripts/release-session.mjs"

test("builds a resume command from the original release arguments", () => {
  const args = ["--release-type=local-publish", "--version=minor", "--registry=https://registry.npmjs.org/"]
  expect(parseResumeArgs([...args, "--resume", "123e4567-e89b-42d3-a456-426614174000"]).resume)
    .toBe("123e4567-e89b-42d3-a456-426614174000")
  expect(buildResumeCommand(args, "123e4567-e89b-42d3-a456-426614174000")).toBe(
    "npm run release -- --release-type=local-publish --version=minor --registry=https://registry.npmjs.org/ --resume 123e4567-e89b-42d3-a456-426614174000",
  )
  expect(buildResumeCommand(["--registry=https://example.test/?a=1&b=2"], "123e4567-e89b-42d3-a456-426614174000"))
    .toContain("'--registry=https://example.test/?a=1&b=2'")
})

test("ignores authorization links that have already been resolved", () => {
  const events = [
    { type: "auth", challenge: "one", url: "https://www.npmjs.com/auth/cli/one" },
    { type: "resolved", challenge: "one" },
    { type: "auth", challenge: "two", url: "https://www.npmjs.com/auth/cli/two" },
  ]
  expect(pendingAuthEvent(events, [])?.challenge).toBe("two")
  expect(pendingAuthEvent(events, ["two"])).toBeUndefined()
})

test("pauses for each auth link and resumes until the detached release completes", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "release-session-"))
  const sessionRoot = path.join(root, "sessions")
  await mkdir(sessionRoot, { recursive: true })
  const script = path.join(root, "fake-release.mjs")
  await writeFile(script, [
    'import { appendFileSync, existsSync, writeFileSync } from "node:fs"',
    'import path from "node:path"',
    'const directory = process.env.RELEASE_SESSION_DIR',
    'const events = process.env.RELEASE_AUTH_EVENT_FILE',
    'const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))',
    'console.log("fake release starting")',
    'appendFileSync(events, JSON.stringify({ type: "auth", challenge: "one", url: "https://www.npmjs.com/auth/cli/one" }) + "\\n")',
    'while (!existsSync(path.join(directory, "authorized-one"))) await sleep(20)',
    'appendFileSync(events, JSON.stringify({ type: "resolved", challenge: "one" }) + "\\n")',
    'appendFileSync(events, JSON.stringify({ type: "auth", challenge: "two", url: "https://www.npmjs.com/auth/cli/two" }) + "\\n")',
    'while (!existsSync(path.join(directory, "authorized-two"))) await sleep(20)',
    'appendFileSync(events, JSON.stringify({ type: "resolved", challenge: "two" }) + "\\n")',
    'writeFileSync(path.join(directory, "done.json"), JSON.stringify({ code: 0, result: { ok: true } }))',
  ].join("\n"))

  const session = createSession({
    args: ["--release-type=local-publish"],
    cwd: root,
    command: process.execPath,
    commandArgs: [script],
    root: sessionRoot,
  })
  let output = ""
  const write = (text: string) => { output += text }
  try {
    const first = await watchSession(session, { write, relayOutput: true, pollMs: 20 })
    expect(first).toMatchObject({ type: "auth", url: "https://www.npmjs.com/auth/cli/one" })
    expect(output).toContain("fake release starting")

    let secondSettled = false
    const secondPromise = watchSession(session, { write, relayOutput: true, pollMs: 20 }).then((value) => {
      secondSettled = true
      return value
    })
    await Bun.sleep(100)
    expect(secondSettled).toBe(false)
    await writeFile(path.join(session.directory, "authorized-one"), "")
    const second = await secondPromise
    expect(second).toMatchObject({ type: "auth", url: "https://www.npmjs.com/auth/cli/two" })

    let doneSettled = false
    const donePromise = watchSession(session, { write, relayOutput: true, pollMs: 20 }).then((value) => {
      doneSettled = true
      return value
    })
    await Bun.sleep(100)
    expect(doneSettled).toBe(false)
    await writeFile(path.join(session.directory, "authorized-two"), "")
    const done = await donePromise
    expect(done).toMatchObject({ type: "done", code: 0, result: { ok: true } })
    expect(loadSession(session.id, { root: sessionRoot })).toMatchObject({
      status: "completed",
      reportedChallenges: ["one", "two"],
    })
  } finally {
    if (!readDone(session) && Number.isInteger(session.pid)) {
      try { process.kill(-session.pid, "SIGTERM") } catch { try { process.kill(session.pid, "SIGTERM") } catch {} }
    }
    await rm(root, { recursive: true, force: true })
  }
})
