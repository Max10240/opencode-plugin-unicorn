import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"

const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g
const AUTH_URL = /https:\/\/www\.npmjs\.com\/(?:auth|login)[^\s"'<>]*/g
const EXIT_MARKER = /__AUTH_EXIT__\s+(-?\d+)/

export function stripAnsi(text) {
  return text.replace(ANSI, "")
}

export function extractAuthUrls(text) {
  return [...stripAnsi(text).matchAll(AUTH_URL)].map((match) => match[0])
}

export function expectCommand(args) {
  const script = fileURLToPath(new URL("./auth-expect.tcl", import.meta.url))
  const environment = { AUTH_ARGC: String(args.length) }
  args.forEach((value, index) => { environment[`AUTH_ARG_${index}`] = value })
  return { command: "expect", args: [script], environment }
}

function authMessage(url) {
  return [
    "",
    "[release] Verification required. Open this URL and complete authentication:",
    "",
    `  ${url}`,
    "",
    "[release] The command continues automatically after verification.",
    "",
  ].join("\n")
}

/**
 * Runs an npm command through expect so npm gets a pseudo-terminal and can emit
 * its web-auth URL. Every URL is printed once; the command continues after the
 * user completes verification in the browser.
 */
export function runWithAuthLinks(args, {
  cwd,
  env = process.env,
  log = (...values) => console.error(...values),
  timeoutMs = 15 * 60_000,
  spawnImpl = spawn,
} = {}) {
  return new Promise((resolve, reject) => {
    const invocation = expectCommand(args)
    let child
    let fallback
    let output = ""
    let settled = false
    const seen = new Set()

    const finish = (code, signal) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      const marked = EXIT_MARKER.exec(stripAnsi(output))
      const status = marked ? Number(marked[1]) : code
      if (status === 0) resolve(output)
      else reject(new Error(`${args.join(" ")} failed (${signal ?? status})\n${stripAnsi(output).slice(-4_000)}`))
    }

    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      ;(fallback ?? child)?.kill?.("SIGTERM")
      reject(new Error(`${args.join(" ")} timed out waiting for authentication`))
    }, timeoutMs)

    const handle = (chunk) => {
      const text = stripAnsi(chunk.toString())
      output = `${output}${text}`.slice(-16_000)
      for (const url of extractAuthUrls(output)) {
        if (seen.has(url)) continue
        seen.add(url)
        log(authMessage(url))
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
        reject(error)
        return
      }
      try {
        fallback = spawnImpl(args[0], args.slice(1), { cwd, env, stdio: "inherit" })
      } catch (next) {
        settled = true
        clearTimeout(timer)
        reject(next)
        return
      }
      fallback.once("close", (code, signal) => finish(code, signal))
      fallback.once("error", (next) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
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
    log("[release] npm login required; waiting for web authentication")
    await authRun(["npm", "login", "--auth-type=web", `--registry=${registry}`])
    return true
  }
}
