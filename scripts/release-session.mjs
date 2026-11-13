import { randomUUID } from "node:crypto"
import { spawn } from "node:child_process"
import {
  chmodSync,
  closeSync,
  fchmodSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { stripAnsi } from "./auth-process.mjs"

const RELEASE_SCRIPT = fileURLToPath(new URL("./release.mjs", import.meta.url))
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const SESSION_FILE = "session.json"
const LOG_FILE = "output.log"
const AUTH_EVENTS_FILE = "auth-events.jsonl"
const DONE_FILE = "done.json"
const READ_CHUNK = 64 * 1024
const READ_LIMIT = 4 * 1024 * 1024

function timestamp() {
  return new Date().toISOString()
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

function currentUid() {
  return typeof process.getuid === "function" ? process.getuid() : undefined
}

function defaultSessionRoot() {
  const configured = process.env.OPENCODE_RELEASE_TMPDIR
  if (configured) return path.resolve(configured)
  if (process.platform === "win32") return path.join(os.tmpdir(), "opencode-plugin-unicorn-release")
  const uid = currentUid() ?? "user"
  return path.join("/tmp", `opencode-plugin-unicorn-release-${uid}`)
}

function prepareRoot(root) {
  mkdirSync(root, { recursive: true, mode: 0o700 })
  const info = lstatSync(root)
  if (!info.isDirectory()) throw new Error(`Release session root is not a directory: ${root}`)
  const uid = currentUid()
  if (uid !== undefined && info.uid !== uid) throw new Error(`Release session root is not owned by the current user: ${root}`)
  chmodSync(root, 0o700)
  return root
}

export function sessionRoot() {
  const configured = process.env.OPENCODE_RELEASE_TMPDIR
  if (configured) return prepareRoot(path.resolve(configured))
  try {
    return prepareRoot(defaultSessionRoot())
  } catch (error) {
    if (configured) throw error
    const uid = currentUid() ?? "user"
    return prepareRoot(path.join(os.tmpdir(), `opencode-plugin-unicorn-release-${uid}`))
  }
}

export function sessionDirectory(id, root = sessionRoot()) {
  if (typeof id !== "string" || !SESSION_ID.test(id)) throw new Error(`Invalid release session id: ${String(id)}`)
  return path.join(root, id)
}

export function writeJsonAtomic(file, value) {
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`
  try {
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: "wx" })
    try {
      renameSync(temporary, file)
    } catch (error) {
      if (process.platform !== "win32") throw error
      try { unlinkSync(file) } catch {}
      renameSync(temporary, file)
    }
  } finally {
    try { unlinkSync(temporary) } catch {}
  }
}

function ensureFile(file) {
  writeFileSync(file, "", { flag: "a", mode: 0o600 })
  chmodSync(file, 0o600)
}

function shellQuote(value) {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) return value
  return `'${String(value).replaceAll("'", "'\\''")}'`
}

export function buildResumeCommand(args, id) {
  const cleaned = []
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]
    if (arg === "--internal") continue
    if (arg === "--resume" || arg === "--session-dir") { index++; continue }
    if (arg.startsWith("--resume=") || arg.startsWith("--session-dir=")) continue
    cleaned.push(arg)
  }
  return ["npm", "run", "release", "--", ...cleaned.map(shellQuote), "--resume", id].join(" ")
}

export function parseResumeArgs(args) {
  let resume
  const rest = []
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]
    if (arg === "--resume") {
      resume = args[++index]
      if (!resume) throw new Error("--resume requires a session id")
      continue
    }
    if (arg.startsWith("--resume=")) {
      resume = arg.slice("--resume=".length)
      if (!resume) throw new Error("--resume requires a session id")
      continue
    }
    rest.push(arg)
  }
  return { resume, args: rest }
}

export function parseInternalArgs(args) {
  let internal = false
  let sessionDir
  const rest = []
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]
    if (arg === "--internal") { internal = true; continue }
    if (arg === "--session-dir") {
      sessionDir = args[++index]
      if (!sessionDir) throw new Error("--session-dir requires a directory")
      continue
    }
    if (arg.startsWith("--session-dir=")) {
      sessionDir = arg.slice("--session-dir=".length)
      if (!sessionDir) throw new Error("--session-dir requires a directory")
      continue
    }
    rest.push(arg)
  }
  return { internal, sessionDir, args: rest }
}

export function createSession({
  args,
  cwd = process.cwd(),
  command = process.execPath,
  commandArgs,
  environment = process.env,
  root,
} = {}) {
  const id = randomUUID()
  const directory = sessionDirectory(id, root ?? sessionRoot())
  mkdirSync(directory, { recursive: false, mode: 0o700 })
  chmodSync(directory, 0o700)

  const logPath = path.join(directory, LOG_FILE)
  const authEventFile = path.join(directory, AUTH_EVENTS_FILE)
  const donePath = path.join(directory, DONE_FILE)
  const statePath = path.join(directory, SESSION_FILE)
  ensureFile(logPath)
  ensureFile(authEventFile)

  const state = {
    version: 1,
    id,
    createdAt: timestamp(),
    updatedAt: timestamp(),
    status: "starting",
    cwd,
    args: [...args],
    resumeCommand: buildResumeCommand(args, id),
    pid: null,
    outputOffset: 0,
    reportedChallenges: [],
    lastAuthUrl: null,
    exitCode: null,
    result: null,
    error: null,
  }
  writeJsonAtomic(statePath, state)

  const logFd = openSync(logPath, "a", 0o600)
  fchmodSync(logFd, 0o600)
  let child
  try {
    child = spawn(command, commandArgs ?? [RELEASE_SCRIPT, "--internal", "--session-dir", directory, ...args], {
      cwd,
      env: {
        ...environment,
        RELEASE_SESSION_DIR: directory,
        RELEASE_SESSION_ID: id,
        RELEASE_AUTH_EVENT_FILE: authEventFile,
        NO_COLOR: "1",
        FORCE_COLOR: "0",
        npm_config_progress: "false",
      },
      detached: true,
      stdio: ["ignore", logFd, logFd],
    })
  } finally {
    closeSync(logFd)
  }

  child.once("error", (error) => {
    try {
      writeJsonAtomic(donePath, {
        code: 1,
        error: { message: error instanceof Error ? error.message : String(error) },
        finishedAt: timestamp(),
      })
    } catch {}
  })
  child.unref()

  state.pid = child.pid ?? null
  state.status = "running"
  state.updatedAt = timestamp()
  try {
    writeJsonAtomic(statePath, state)
  } catch (error) {
    if (Number.isInteger(child.pid)) {
      try { process.kill(-child.pid, "SIGTERM") } catch { try { process.kill(child.pid, "SIGTERM") } catch {} }
    }
    throw error
  }

  return {
    ...state,
    directory,
    statePath,
    logPath,
    authEventFile,
    donePath,
  }
}

export function loadSession(id, { root } = {}) {
  const directory = sessionDirectory(id, root ?? sessionRoot())
  const statePath = path.join(directory, SESSION_FILE)
  let state
  try {
    state = JSON.parse(readFileSync(statePath, "utf8"))
  } catch {
    throw new Error(`Release session ${id} not found at ${directory}`)
  }
  if (!state || typeof state !== "object" || state.id !== id) {
    throw new Error(`Release session ${id} is invalid`)
  }
  return {
    ...state,
    directory,
    statePath,
    logPath: path.join(directory, LOG_FILE),
    authEventFile: path.join(directory, AUTH_EVENTS_FILE),
    donePath: path.join(directory, DONE_FILE),
  }
}

export function readAuthEvents(file) {
  let text
  try {
    text = readFileSync(file, "utf8")
  } catch {
    return []
  }
  const lines = text.split("\n")
  const events = []
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index].trim()
    if (!line) continue
    if (index === lines.length - 1 && !text.endsWith("\n")) break
    try {
      const event = JSON.parse(line)
      if (event && typeof event === "object" && typeof event.type === "string") events.push(event)
    } catch {}
  }
  return events
}

export function pendingAuthEvent(events, reportedChallenges = []) {
  const reported = new Set(Array.isArray(reportedChallenges) ? reportedChallenges : [])
  const resolved = new Set(
    events
      .filter((event) => event.type === "resolved" && typeof event.challenge === "string")
      .map((event) => event.challenge),
  )
  for (const event of events) {
    if (event.type !== "auth" || typeof event.url !== "string" || !event.url) continue
    const challenge = typeof event.challenge === "string" && event.challenge ? event.challenge : event.url
    if (reported.has(challenge) || resolved.has(challenge)) continue
    return { ...event, challenge }
  }
  return undefined
}

export function readDone(session) {
  try {
    const done = JSON.parse(readFileSync(session.donePath, "utf8"))
    if (!done || typeof done !== "object" || !Number.isInteger(done.code)) return undefined
    return done
  } catch {
    return undefined
  }
}

export function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === "EPERM"
  }
}

export function tailOutput(session, state, write = (text) => process.stdout.write(text)) {
  let size
  try {
    size = statSync(session.logPath).size
  } catch {
    return
  }
  let offset = Number.isSafeInteger(state.outputOffset) && state.outputOffset >= 0 ? state.outputOffset : 0
  if (size < offset) offset = 0
  if (size === offset) return

  const fd = openSync(session.logPath, "r")
  try {
    let remaining = Math.min(size - offset, READ_LIMIT)
    while (remaining > 0) {
      const buffer = Buffer.alloc(Math.min(remaining, READ_CHUNK))
      const read = readSync(fd, buffer, 0, buffer.length, offset)
      if (read <= 0) break
      write(stripAnsi(buffer.subarray(0, read).toString("utf8")))
      offset += read
      remaining -= read
    }
  } finally {
    closeSync(fd)
  }
  state.outputOffset = offset
}

export async function watchSession(session, {
  write = (text) => process.stdout.write(text),
  relayOutput = false,
  pollMs = 200,
  signal,
} = {}) {
  const state = session
  state.status = "running"
  state.updatedAt = timestamp()
  const trackOutput = () => {
    if (relayOutput) tailOutput(session, state, write)
    else {
      try { state.outputOffset = statSync(session.logPath).size } catch {}
    }
  }
  let missingSince = 0
  let lastStateWrite = 0
  while (true) {
    if (signal?.aborted) return { type: "aborted", state }
    const done = readDone(session)
    if (done) {
      await sleep(50)
      trackOutput()
      state.status = done.code === 0 ? "completed" : "failed"
      state.exitCode = done.code
      state.result = done.result ?? null
      state.error = done.error ?? null
      state.updatedAt = timestamp()
      try { writeJsonAtomic(session.statePath, state) } catch {}
      return { type: "done", code: done.code, result: done.result, error: done.error, state }
    }

    const events = readAuthEvents(session.authEventFile)
    const pending = pendingAuthEvent(events, state.reportedChallenges)
    if (pending) {
      trackOutput()
      write(authInstruction(pending.url, buildResumeCommand(state.args, state.id)))
      state.reportedChallenges = [
        ...(Array.isArray(state.reportedChallenges) ? state.reportedChallenges : []),
        pending.challenge,
      ]
      state.lastAuthUrl = pending.url
      state.status = "waiting-auth"
      state.updatedAt = timestamp()
      try { writeJsonAtomic(session.statePath, state) } catch {}
      return { type: "auth", url: pending.url, challenge: pending.challenge, state }
    }

    trackOutput()
    if (Date.now() - lastStateWrite > 2_000) {
      state.updatedAt = timestamp()
      try { writeJsonAtomic(session.statePath, state) } catch {}
      lastStateWrite = Date.now()
    }

    if (!processAlive(state.pid)) {
      if (!missingSince) missingSince = Date.now()
      if (Date.now() - missingSince > 1_000) {
        const late = readDone(session)
        if (late) continue
        state.status = "failed"
        state.error = { message: "Release process exited without writing a result" }
        state.updatedAt = timestamp()
        try { writeJsonAtomic(session.statePath, state) } catch {}
        return { type: "crashed", state }
      }
    } else {
      missingSince = 0
    }

    await sleep(pollMs)
  }
}

export function authInstruction(url, resumeCommand) {
  return `\n${url}\n\nWaiting for user to authorize\n\nPlease run \`${resumeCommand}\`\n\n`
}

export function writeDone(sessionDir, value) {
  writeJsonAtomic(path.join(sessionDir, DONE_FILE), {
    ...value,
    finishedAt: timestamp(),
  })
}

export function flushOutput() {
  for (const fd of [1, 2]) {
    try { fsyncSync(fd) } catch {}
  }
}
