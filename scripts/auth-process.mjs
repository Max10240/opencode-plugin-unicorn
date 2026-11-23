import { randomUUID } from "node:crypto"
import { spawn } from "node:child_process"
import { appendFileSync, chmodSync, mkdirSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g
const AUTH_URL = /https:\/\/www\.npmjs\.com\/(?:auth|login)[^\s"'<>]*/g
const AUTH_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const EXIT_MARKER = /__AUTH_EXIT__\s+(-?\d+)/
const DEFAULT_AUTH_TIMEOUT_MS = 5 * 60_000 + 30_000
const DEFAULT_AUTH_POLL_MS = 5_000
const AUTH_EXPIRY_WARNING_MS = 60_000

function positiveNumber(value, fallback) {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? number : fallback
}

const AUTH_TIMEOUT_MS = positiveNumber(process.env.RELEASE_AUTH_TIMEOUT_MS, DEFAULT_AUTH_TIMEOUT_MS)
const AUTH_POLL_MS = positiveNumber(process.env.RELEASE_AUTH_POLL_MS, DEFAULT_AUTH_POLL_MS)

export function stripAnsi(text) {
  return text.replace(ANSI, "")
}

export function extractAuthUrls(text) {
  return [...stripAnsi(text).matchAll(AUTH_URL)].map((match) => match[0].replace(/[),.;]+$/, ""))
}

/**
 * npm's publish OTP link carries the challenge id in `/auth/cli/<id>`. The
 * matching status endpoint is the registry's done URL, the same one npm polls:
 * 200 = approved, 202 = pending, 404/410 = expired or consumed.
 *
 * `npm login` prints `/login?next=/login/cli/<id>` instead; that id is a login
 * session, not a done authId, so there is no derivable status endpoint. Login
 * links rely on the local expiry window.
 */
export function authChallenge(url, registry = "https://registry.npmjs.org/") {
  let parsed
  try {
    parsed = new URL(url)
  } catch {
    return undefined
  }
  const direct = /^\/auth\/cli\/([^/]+)\/?$/.exec(parsed.pathname)
  const id = direct?.[1]
  if (id === undefined || !AUTH_ID.test(id)) return undefined
  return {
    id,
    doneUrl: `${registry.replace(/\/+$/, "")}/-/v1/done?authId=${encodeURIComponent(id)}`,
  }
}

export function expectCommand(args) {
  const script = fileURLToPath(new URL("./auth-expect.tcl", import.meta.url))
  const environment = { AUTH_ARGC: String(args.length) }
  args.forEach((value, index) => { environment[`AUTH_ARG_${index}`] = value })
  return { command: "expect", args: [script], environment }
}

function authMessage(url, expiresAt) {
  return [
    "",
    "[release] Verification required. Open this URL and complete authentication:",
    "",
    `  ${url}`,
    "",
    ...(expiresAt === undefined ? [] : [`[release] This link expires at ${expiresAt}.`]),
    "[release] The command continues automatically after verification.",
    "",
  ].join("\n")
}

function appendAuthEvent(file, event) {
  if (!file) return false
  try {
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
    appendFileSync(file, `${JSON.stringify(event)}\n`, { mode: 0o600 })
    try { chmodSync(file, 0o600) } catch {}
    return true
  } catch {
    return false
  }
}

/**
 * Runs an npm command through expect so npm gets a pseudo-terminal and can emit
 * its web-auth URL. Every URL is printed once; the command continues after the
 * user completes verification in the browser.
 *
 * When authEventFile is set, URLs are also appended as JSON lines so a detached
 * release supervisor can pause the foreground command and resume it later.
 */
export function runWithAuthLinks(args, {
  cwd,
  env = process.env,
  log = (...values) => console.error(...values),
  timeoutMs = 15 * 60_000,
  authTimeoutMs = AUTH_TIMEOUT_MS,
  authPollMs = AUTH_POLL_MS,
  authExpiryGraceMs = 30_000,
  registry = "https://registry.npmjs.org/",
  fetchImpl = fetch,
  sleepImpl,
  now = Date.now,
  spawnImpl = spawn,
  authEventFile,
} = {}) {
  return new Promise((resolve, reject) => {
    const invocation = expectCommand(args)
    const challenge = randomUUID()
    let child
    let fallback
    let output = ""
    let settled = false
    let resolved = false
    let announced = false
    const seen = new Set()
    const monitors = new Set()
    const expiryTimers = new Set()

    const wait = sleepImpl ?? ((milliseconds) => new Promise((done) => {
      const timer = setTimeout(done, milliseconds)
      timer.unref?.()
    }))

    const record = (event) => appendAuthEvent(authEventFile, { challenge, ...event, at: new Date().toISOString() })
    const settle = () => {
      if (resolved) return
      resolved = true
      record({ type: "resolved" })
    }

    const killChild = () => {
      const target = fallback ?? child
      if (!target) return
      try { target.kill?.("SIGTERM") } catch {}
      const timer = setTimeout(() => {
        try { target.kill?.("SIGKILL") } catch {}
      }, 2_000)
      timer.unref?.()
    }

    const failAuth = (url, reason) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      for (const handle of expiryTimers) clearTimeout(handle)
      expiryTimers.clear()
      for (const monitor of monitors) monitor.closed = true
      record({ type: "expired", url, reason })
      settle()
      killChild()
      const detail = reason === "timeout"
        ? "the browser verification window expired"
        : reason === "network"
          ? "the npm registry could not confirm the verification status"
          : "the browser verification link expired or was rejected"
      reject(new Error(`${args.join(" ")} failed: ${detail} (${url}). Rerun the release command to get a new link.`))
    }

    const monitorAuth = (url) => {
      const status = authChallenge(url, registry)
      const monitor = { url, doneUrl: status?.doneUrl, deadline: now() + authTimeoutMs, closed: false, warned: false }
      monitors.add(monitor)
      void (async () => {
        let interval = authPollMs
        let failures = 0
        while (!settled && !monitor.closed) {
          const remaining = monitor.deadline - now()
          if (remaining <= 0) {
            failAuth(url, "timeout")
            return
          }
          if (!monitor.warned && remaining <= AUTH_EXPIRY_WARNING_MS) {
            monitor.warned = true
            log(`[release] Authentication link expires in ${Math.ceil(remaining / 1000)}s: ${url}`)
          }
          await wait(Math.min(interval, Math.max(remaining, 1)))
          if (settled || monitor.closed) return
          if (monitor.doneUrl === undefined) continue
          let response
          try {
            response = await fetchImpl(monitor.doneUrl, {
              redirect: "error",
              cache: "no-store",
              signal: AbortSignal.timeout(10_000),
            })
          } catch {
            failures += 1
            interval = Math.min(interval * 2, 30_000)
            if (failures >= 5) {
              failAuth(url, "network")
              return
            }
            continue
          }
          failures = 0
          await response.body?.cancel?.().catch?.(() => {})
          if (response.status === 200) {
            monitor.closed = true
            record({ type: "approved", url })
            return
          }
          if (response.status === 202) {
            const retry = Number(response.headers.get("retry-after")) * 1000
            interval = retry > 0 ? retry : authPollMs
            continue
          }
          if (response.status === 404 || response.status === 410) {
            // npm consumes the challenge on success, so a single 404 can race a
            // completed publish. Wait briefly for npm to settle; if it keeps
            // running without reporting, treat the link as expired.
            monitor.closed = true
            log("[release] The browser verification link is no longer pending; waiting for npm to report the result.")
            const handle = setTimeout(() => {
              expiryTimers.delete(handle)
              failAuth(url, "expired")
            }, authExpiryGraceMs)
            handle.unref?.()
            expiryTimers.add(handle)
            return
          }
          if (response.status === 401 || response.status === 403) {
            failAuth(url, "denied")
            return
          }
          interval = Math.min(interval * 2, 30_000)
        }
      })()
    }

    const finish = (code, signal) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      for (const handle of expiryTimers) clearTimeout(handle)
      expiryTimers.clear()
      for (const monitor of monitors) monitor.closed = true
      settle()
      const marked = EXIT_MARKER.exec(stripAnsi(output))
      const status = marked ? Number(marked[1]) : code
      if (status === 0) resolve(output)
      else reject(new Error(`${args.join(" ")} failed (${signal ?? status})\n${stripAnsi(output).slice(-4_000)}`))
    }

    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      for (const handle of expiryTimers) clearTimeout(handle)
      expiryTimers.clear()
      for (const monitor of monitors) monitor.closed = true
      settle()
      killChild()
      reject(new Error(`${args.join(" ")} timed out waiting for authentication`))
    }, timeoutMs)

    const handle = (chunk) => {
      const text = stripAnsi(chunk.toString())
      output = `${output}${text}`.slice(-16_000)
      for (const url of extractAuthUrls(output)) {
        if (seen.has(url)) continue
        seen.add(url)
        const expiresAt = new Date(now() + authTimeoutMs).toISOString()
        const recorded = record({ type: "auth", url, expiresAt })
        monitorAuth(url)
        if (authEventFile && recorded) {
          if (!announced) {
            log("[release] Browser authentication required. Complete it in the browser; the release will continue in the background.")
            announced = true
          }
        } else {
          log(authMessage(url, expiresAt))
        }
      }
      if (seen.size > 0 && /npm notice Publishing to|Publishing to https?:\/\//.test(text)) {
        for (const monitor of monitors) monitor.closed = true
        for (const handle of expiryTimers) clearTimeout(handle)
        expiryTimers.clear()
      }
    }

    try {
      child = spawnImpl(invocation.command, invocation.args, {
        cwd,
        env: { ...env, ...invocation.environment, npm_config_progress: "false", NO_COLOR: "1" },
        stdio: ["ignore", "pipe", "pipe"],
      })
    } catch (error) {
      settled = true
      clearTimeout(timer)
      settle()
      reject(error)
      return
    }

    child.stdout?.on("data", handle)
    child.stderr?.on("data", handle)
    child.once("error", (error) => {
      if (settled || fallback) return
      if (error.code !== "ENOENT") {
        settled = true
        clearTimeout(timer)
        settle()
        reject(error)
        return
      }
      try {
        fallback = spawnImpl(args[0], args.slice(1), { cwd, env, stdio: "inherit" })
      } catch (next) {
        settled = true
        clearTimeout(timer)
        settle()
        reject(next)
        return
      }
      fallback.once("close", (code, signal) => finish(code, signal))
      fallback.once("error", (next) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        settle()
        reject(next)
      })
    })
    child.once("close", (code, signal) => {
      if (!fallback) finish(code, signal)
    })
  })
}

export async function ensureNpmLogin({
  registry,
  run,
  authRun,
  log = (...values) => console.error(...values),
} = {}) {
  try {
    await run(["npm", "whoami", `--registry=${registry}`], { capture: true })
    return false
  } catch {
    log("[release] npm login required")
    await authRun(["npm", "login", "--auth-type=web", `--registry=${registry}`])
    return true
  }
}
