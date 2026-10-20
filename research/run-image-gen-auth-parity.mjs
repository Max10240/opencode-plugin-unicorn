import { spawn } from "node:child_process"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const root = fileURLToPath(new URL("../", import.meta.url))
export function isolatedEnvironment(home, parent = process.env) {
  return {
    PATH: parent.PATH ?? "/usr/bin:/bin:/opt/homebrew/bin",
    HOME: home,
    TMPDIR: parent.TMPDIR ?? os.tmpdir(),
    LANG: "en_US.UTF-8",
    OPENCODE_CONFIG_DIR: path.join(home, "config"),
    OPENCODE_CONFIG_PROJECT_DISABLE: "1",
    OPENCODE_DISABLE_MODELS_FETCH: "1",
    XDG_CONFIG_HOME: path.join(home, "xdg-config"),
    XDG_DATA_HOME: path.join(home, "xdg-data"),
    XDG_CACHE_HOME: path.join(home, "xdg-cache"),
    XDG_STATE_HOME: path.join(home, "xdg-state"),
    ...(parent.OPENCODE_BIN ? { OPENCODE_BIN: parent.OPENCODE_BIN } : {}),
  }
}
export const networkSandboxProfile = '(version 1)(allow default)(deny network-outbound)(allow network-outbound (remote ip "localhost:*"))'

export async function runResearch() {
  const home = await mkdtemp(path.join(os.tmpdir(), "opencode-auth-research-run-"))
  const environment = isolatedEnvironment(home)
  const sandbox = process.platform === "darwin" ? ["/usr/bin/sandbox-exec", "-p", networkSandboxProfile] : []
  let activeStop
  let interrupted
  const onInterrupt = () => { interrupted = "SIGINT"; activeStop?.() }
  const onTerminate = () => { interrupted = "SIGTERM"; activeStop?.() }
  process.on("SIGINT", onInterrupt)
  process.on("SIGTERM", onTerminate)
  async function run(args, cwd) {
    if (interrupted) throw new Error("Research interrupted")
    const command = [...sandbox, ...args]
    await new Promise((resolve, reject) => {
      const child = spawn(command[0], command.slice(1), { cwd, env: environment, stdio: "inherit", detached: process.platform !== "win32" })
      const stop = () => {
        try {
          if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGKILL")
          else child.kill("SIGKILL")
        } catch (error) { if (error.code !== "ESRCH") throw error }
      }
      activeStop = stop
      const timer = setTimeout(() => { stop(); reject(new Error("Research command timed out")) }, 300_000)
      child.once("error", (error) => { clearTimeout(timer); stop(); activeStop = undefined; reject(error) })
      child.once("exit", (code, signal) => {
        clearTimeout(timer)
        stop()
        activeStop = undefined
        if (code === 0) resolve()
        else reject(new Error(`Research command failed (${signal ?? code})`))
      })
    })
  }

  try {
    await mkdir(environment.OPENCODE_CONFIG_DIR, { recursive: true })
    console.log(`Research isolation: clean environment and temporary HOME${sandbox.length ? "; localhost-only network sandbox" : ""}`)
    await run(["bun", "run", "build"], path.join(root, "packages/opencode-plugin-image-gen"))
    await run(["bun", "test", "research/image-gen-auth-parity.test.ts"], root)
  } catch (error) {
    console.error(error.message)
    process.exitCode = interrupted === "SIGINT" ? 130 : interrupted === "SIGTERM" ? 143 : 1
  } finally {
    activeStop?.()
    process.off("SIGINT", onInterrupt)
    process.off("SIGTERM", onTerminate)
    await rm(home, { recursive: true, force: true })
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await runResearch()
