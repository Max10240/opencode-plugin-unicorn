import path from "node:path"
import type { OpenCodeE2E } from "../packages/opencode-plugin-unicorn/test/e2e-utils.js"
import { createTmux } from "./tmux.js"

const PASSWORD = "opencode-plugin-unicorn-e2e"

export type Tui = ReturnType<typeof createTui>

export function createTui(e2e: OpenCodeE2E, sessionID: string, name: string, options: { width?: number; height?: number; environment?: Record<string, string> } = {}) {
  const tmux = createTmux()
  const target = name
  const environment = {
    PATH: process.env.PATH ?? "/usr/bin:/bin:/opt/homebrew/bin",
    TERM: "xterm-256color",
    ...(process.env.TMPDIR === undefined ? {} : { TMPDIR: process.env.TMPDIR }),
    HOME: e2e.root,
    OPENCODE_CONFIG_DIR: e2e.configDirectory,
    OPENCODE_CONFIG_PROJECT_DISABLE: "1",
    OPENCODE_DB: path.join(e2e.root, "opencode.db"),
    OPENCODE_DISABLE_MODELS_FETCH: "1",
    OPENCODE_PASSWORD: PASSWORD,
    OPENCODE_TEST_HOME: e2e.root,
    XDG_CONFIG_HOME: path.join(e2e.root, "xdg-config"),
    XDG_DATA_HOME: path.join(e2e.root, "xdg-data"),
    XDG_CACHE_HOME: path.join(e2e.root, "xdg-cache"),
    XDG_STATE_HOME: path.join(e2e.root, "xdg-state"),
    ...options.environment,
  }
  const binary = process.env.OPENCODE_BIN ?? "opencode"
  const command = [
    `cd ${quote(e2e.workspace)} && env -i`,
    ...Object.entries(environment).map(([key, value]) => `${key}=${quote(value)}`),
    [binary, "--server", e2e.baseURL, "--session", sessionID].map(quote).join(" "),
  ].join(" ")
  tmux(["new-session", "-d", "-s", target, "-x", String(options.width ?? 160), "-y", String(options.height ?? 48), command])
  const handle = {
    tmux,
    target,
    pane: () => tmux(["capture-pane", "-p", "-t", target], false).stdout.toString(),
    send: (keys: string[]) => tmux(["send-keys", "-t", target, ...keys]),
    type: (text: string) => tmux(["send-keys", "-t", target, "-l", text]),
    async waitFor(text: string, message: string, timeout = 30_000) {
      try {
        await waitFor(async () => handle.pane().includes(text), message, timeout)
      } catch (error) {
        throw new Error(`${error instanceof Error ? error.message : String(error)}\n--- ${target} ---\n${handle.pane()}`)
      }
    },
    async waitUntil(check: () => boolean, message: string, timeout = 30_000) {
      try {
        await waitFor(async () => check(), message, timeout)
      } catch (error) {
        throw new Error(`${error instanceof Error ? error.message : String(error)}\n--- ${target} ---\n${handle.pane()}`)
      }
    },
    async close() {
      tmux(["kill-server"], false)
    },
  }
  return handle
}

export async function waitFor<T>(check: () => Promise<T | false>, message: string, timeout = 30_000): Promise<T> {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const result = await check()
    if (result !== false) return result
    await Bun.sleep(25)
  }
  throw new Error(message)
}

function quote(value: string) {
  return `'${value.replaceAll("'", "'\\''")}'`
}
