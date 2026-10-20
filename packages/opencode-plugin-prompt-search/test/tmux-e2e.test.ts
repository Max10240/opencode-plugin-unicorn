import { expect, setDefaultTimeout, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import { LLMock } from "@copilotkit/aimock"
import { commandIsListed } from "./palette.js"
import { createTmux } from "../../../test/tmux.js"
import { e2eEnvironment } from "../../opencode-plugin-unicorn/test/e2e-environment.js"

const tmux = createTmux()

setDefaultTimeout(120_000)

test("searches and inserts prompts from live and deleted sessions through the real TUI overlay", async () => {
  if (Bun.spawnSync(["tmux", "-V"]).exitCode !== 0) throw new Error("tmux is required for this E2E test")

  try {
    await runScenario("standalone")
    await runScenario("unicorn")
  } finally { tmux(["kill-server"], false) }
})

async function runScenario(mode: "standalone" | "unicorn") {
  const root = await mkdtemp(path.join(os.tmpdir(), "opencode-prompt-search-e2e-"))
  const config = path.join(root, "config")
  const workspaceHistory = path.join(root, "history")
  const workspaceCurrent = path.join(root, "current")
  const promptSearchRoot = path.resolve(import.meta.dir, "../dist")
  const unicornRoot = path.resolve(import.meta.dir, "../../opencode-plugin-unicorn/dist")
  const pluginRoot = mode === "standalone" ? promptSearchRoot : unicornRoot
  const tmuxName = `opencode-prompt-search-${mode}-${process.pid}`
  const password = "prompt-search-e2e"
  const serverPort = await freePort()
  const serverURL = `http://127.0.0.1:${serverPort}`
  const proxy = await startProviderProxy()

  try {
    await mkdir(config, { recursive: true })
    await mkdir(workspaceHistory, { recursive: true })
    await mkdir(workspaceCurrent, { recursive: true })
    await writeFile(
      path.join(config, "opencode.jsonc"),
      `${JSON.stringify(
        {
          $schema: "https://opencode.ai/config.json",
          providers: {
            test: {
              name: "Prompt search E2E",
              package: "@opencode/ai/providers/openai-compatible",
              settings: { baseURL: proxy.baseURL, apiKey: "e2e", provider: "test" },
              models: { "test-model": { name: "Prompt search E2E", limit: { context: 100_000, output: 2_000 } } },
            },
          },
          agents: {
            "prompt-search-e2e": { model: "test/test-model", mode: "primary", steps: 1 },
          },
        },
        null,
        2,
      )}\n`,
    )
    const writeCLIConfig = (promptSearchEnabled: boolean) =>
      writeFile(
        path.join(config, "cli.json"),
        `${JSON.stringify(
          {
            keybinds: { "command.palette.show": "f10" },
            plugins: [
              {
                package: pluginRoot,
                options:
                  mode === "standalone"
                    ? { keybind: "f12", maxPrompts: 2_000 }
                    : { keybind: "f12", maxPrompts: 2_000, features: { promptSearch: promptSearchEnabled } },
              },
            ],
          },
          null,
          2,
        )}\n`,
      )
    await writeCLIConfig(mode !== "unicorn")

    const environment = {
      ...e2eEnvironment({ root, configDirectory: config, password }),
      TERM: "xterm-256color",
      OPENCODE_CONFIG_DIR: config,
      OPENCODE_CONFIG_PROJECT_DISABLE: "1",
      OPENCODE_DB: path.join(root, "opencode.db"),
      OPENCODE_DISABLE_MODELS_FETCH: "1",
      OPENCODE_PASSWORD: password,
      OPENCODE_TEST_HOME: root,
      HOME: root,
      XDG_CONFIG_HOME: path.join(root, "xdg-config"),
      XDG_DATA_HOME: path.join(root, "xdg-data"),
      XDG_CACHE_HOME: path.join(root, "xdg-cache"),
      XDG_STATE_HOME: path.join(root, "xdg-state"),
    }
    const binary = process.env.OPENCODE_BIN ?? "opencode"
    const envCommand = (cwd: string, args: string[]) =>
      [
        `cd ${shellQuote(cwd)} && env -i`,
        ...Object.entries(environment).map(([key, value]) => `${key}=${shellQuote(value)}`),
        [binary, ...args].map(shellQuote).join(" "),
      ].join(" ")

    tmux(["new-session", "-d", "-s", tmuxName, "-n", "server", envCommand(root, ["serve", "--hostname", "127.0.0.1", "--port", String(serverPort)])])
    await waitFor(
      async () => (await fetch(`${serverURL}/api/info`, { headers: auth(password) }).catch(() => undefined))?.ok === true,
      "OpenCode server did not start",
    )

    const history = await createSession(serverURL, password, workspaceHistory)
    for (let index = 1; index <= 12; index++) {
      await sendPrompt(serverURL, password, history.id, `history-candidate-${String(index).padStart(2, "0")} from another session`)
      await Bun.sleep(20)
    }
    const current = await createSession(serverURL, password, workspaceCurrent)
    const requestsBeforeSelection = proxy.mock.getRequests().length

    if (mode === "unicorn") {
      const disabledTarget = `${tmuxName}:tui-disabled`
      tmux(["new-window", "-t", tmuxName, "-n", "tui-disabled", envCommand(workspaceCurrent, ["--server", serverURL, "--session", current.id])])
      await waitForPane(disabledTarget, "Prompt-Search-E2e", "TUI with prompt search disabled did not start")
      tmux(["send-keys", "-t", disabledTarget, "F12"])
      tmux(["send-keys", "-t", disabledTarget, "prompt-search-disabled-check"])
      await waitForPane(disabledTarget, "prompt-search-disabled-check", "disabled Unicorn TUI did not leave the composer usable")
      const disabledScreen = new TextDecoder().decode(tmux(["capture-pane", "-p", "-t", disabledTarget]).stdout)
      expect(disabledScreen).not.toContain("Search previous prompts")
      tmux(["kill-window", "-t", disabledTarget])
      await writeCLIConfig(true)
    }

    tmux(["new-window", "-t", tmuxName, "-n", "tui", envCommand(workspaceCurrent, ["--server", serverURL, "--session", current.id])])
    await waitForPane(`${tmuxName}:tui`, "Prompt-Search-E2e", "TUI did not start")
    await waitForSearchCommand(`${tmuxName}:tui`)

    const target = `${tmuxName}:tui`
    const prefix = "draft-before "
    const suffix = " draft-after"
    tmux(["send-keys", "-t", target, `${prefix}${suffix}`])
    await waitForPane(target, prefix, "composer draft did not appear")
    tmux(["send-keys", "-t", target, ...Array.from({ length: suffix.length }, () => "Left")])

    tmux(["send-keys", "-t", target, "F12"])
    await waitForPane(target, "Search previous prompts", "prompt search dialog did not open")
    const prompt = "history-candidate-01 from another session"
    tmux(["send-keys", "-t", target, "history-candidate"])
    await waitForPane(target, "history-candidate-12", "prompt search did not filter the previous prompts")
    tmux(["send-keys", "-t", target, ...Array.from({ length: 11 }, () => "Down")])
    await waitForPane(target, "history-candidate-01", "selected candidate did not scroll into view")
    tmux(["send-keys", "-t", target, ...Array.from({ length: 11 }, () => "Up")])
    await waitForPane(target, "history-candidate-12", "selected candidate did not scroll back into view")
    tmux(["send-keys", "-t", target, ...Array.from({ length: 11 }, () => "Down")])
    await waitForPane(target, "history-candidate-01", "selected candidate did not scroll into view again")
    tmux(["send-keys", "-t", target, "Enter"])

    const expected = `${prefix}${prompt}${suffix}`
    await waitForPane(target, expected, "selected previous prompt was not inserted into the composer")

    const exported = await api<{ data: { messages: Array<Record<string, any>> } }>(
      serverURL,
      password,
      `/api/experimental/session/${current.id}/export`,
    )
    expect(exported.data.messages.some((message) => message.type === "user" && message.text === expected)).toBe(false)
    expect(proxy.mock.getRequests().length).toBe(requestsBeforeSelection)

    await api(serverURL, password, `/api/session/${history.id}`, { method: "DELETE" })
    const deleted = await fetch(`${serverURL}/api/session/${history.id}`, { headers: auth(password) })
    expect(deleted.status).toBe(404)

    tmux(["kill-window", "-t", target])
    const restartedTarget = `${tmuxName}:tui-after-delete`
    tmux(["new-window", "-t", tmuxName, "-n", "tui-after-delete", envCommand(workspaceCurrent, ["--server", serverURL, "--session", current.id])])
    await waitForPane(restartedTarget, "Prompt-Search-E2e", "restarted TUI did not start")

    // Force a refresh after restart, when the deleted session is no longer in the API list.
    const workspaceTrigger = path.join(root, "refresh-trigger")
    await mkdir(workspaceTrigger, { recursive: true })
    await createSession(serverURL, password, workspaceTrigger)
    await waitForSearchCommand(restartedTarget)
    tmux(["send-keys", "-t", restartedTarget, "F12"])
    await waitForPane(restartedTarget, "Search previous prompts", "prompt search did not reopen after deletion")
    tmux(["send-keys", "-t", restartedTarget, "history-candidate-01"])
    tmux(["send-keys", "-t", restartedTarget, ...Array.from({ length: 11 }, () => "Down")])
    await waitForPane(restartedTarget, prompt, "indexed prompt from a deleted session was not retained")
    tmux(["send-keys", "-t", restartedTarget, "Enter"])
    await waitForPane(restartedTarget, prompt, "prompt from a deleted session could not be inserted")
    expect(proxy.mock.getRequests().length).toBe(requestsBeforeSelection)
  } finally {
    tmux(["kill-session", "-t", tmuxName], false)
    await proxy.close()
    await rm(root, { recursive: true, force: true })
  }
}

async function createSession(serverURL: string, password: string, directory: string) {
  const response = await api<{ data: { id: string } }>(serverURL, password, "/api/session", {
    method: "POST",
    body: JSON.stringify({
      title: path.basename(directory),
      agent: "prompt-search-e2e",
      model: { providerID: "test", id: "test-model" },
      location: { directory },
    }),
  })
  return response.data
}

async function sendPrompt(serverURL: string, password: string, sessionID: string, text: string) {
  await api(serverURL, password, `/api/session/${sessionID}/prompt`, {
    method: "POST",
    body: JSON.stringify({ text, delivery: "queue" }),
  })
  await api(serverURL, password, `/api/experimental/session/${sessionID}/wait`, { method: "POST" })
}

async function startProviderProxy() {
  const mock = new LLMock({ port: 0 })
  mock.onMessage(/.*/, { content: "E2E_OK" })
  await mock.start()
  return { baseURL: `${mock.url}/v1`, mock, close: () => mock.stop() }
}

async function api<T>(baseURL: string, password: string, endpoint: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${baseURL}${endpoint}`, {
    ...init,
    headers: { ...auth(password), ...(init.body === undefined ? {} : { "content-type": "application/json" }), ...init.headers },
  })
  const text = await response.text()
  if (!response.ok) throw new Error(`${init.method ?? "GET"} ${endpoint} failed: ${response.status} ${text}`)
  return text.length === 0 ? (undefined as T) : (JSON.parse(text) as T)
}

function auth(password: string) {
  return { authorization: `Basic ${btoa(`opencode:${password}`)}` }
}

async function waitForPane(target: string, text: string, message: string) {
  try {
    await waitFor(
      async () => new TextDecoder().decode(tmux(["capture-pane", "-p", "-t", target], false).stdout).includes(text) || false,
      message,
    )
  } catch (error) {
    const output = new TextDecoder().decode(tmux(["capture-pane", "-p", "-t", target], false).stdout)
    throw new Error(`${error instanceof Error ? error.message : String(error)}\n--- ${target} ---\n${output}`)
  }
}

async function waitForSearchCommand(target: string) {
  tmux(["send-keys", "-t", target, "F10"])
  tmux(["send-keys", "-t", target, "-l", "Search previous prompts"])
  await waitFor(async () => commandIsListed(new TextDecoder().decode(tmux(["capture-pane", "-p", "-t", target]).stdout), "Search previous prompts") || false,
    "Prompt search command did not register")
  tmux(["send-keys", "-t", target, "Escape"])
  await waitFor(async () => !new TextDecoder().decode(tmux(["capture-pane", "-p", "-t", target]).stdout).includes("Search previous prompts") || false,
    "Command palette did not close")
}

async function waitFor<T>(check: () => Promise<T | false>, message: string, timeout = 30_000): Promise<T> {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const result = await check()
    if (result !== false) return result
    await Bun.sleep(100)
  }
  throw new Error(message)
}

async function freePort() {
  const server = net.createServer()
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => resolve())
  })
  const address = server.address()
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
  if (address === null || typeof address === "string") throw new Error("Could not determine a free port")
  return address.port
}

function shellQuote(value: string) {
  return `'${value.replaceAll("'", "'\\''")}'`
}
