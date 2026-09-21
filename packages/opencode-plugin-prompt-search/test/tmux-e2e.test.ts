import { expect, setDefaultTimeout, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import net from "node:net"
import os from "node:os"
import path from "node:path"

setDefaultTimeout(120_000)

test("searches a previous prompt across sessions through the real TUI overlay", async () => {
  if (Bun.spawnSync(["tmux", "-V"]).exitCode !== 0) throw new Error("tmux is required for this E2E test")

  const root = await mkdtemp(path.join(os.tmpdir(), "opencode-prompt-search-e2e-"))
  const config = path.join(root, "config")
  const workspaceHistory = path.join(root, "history")
  const workspaceCurrent = path.join(root, "current")
  const pluginRoot = path.resolve(import.meta.dir, "..")
  const tmuxName = `opencode-prompt-search-${process.pid}`
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
    await writeFile(
      path.join(config, "cli.json"),
      `${JSON.stringify({ plugins: [{ package: pluginRoot, options: { keybind: "f12" } }] }, null, 2)}\n`,
    )

    const environment = {
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
        `cd ${shellQuote(cwd)} && env`,
        ...Object.entries(environment).map(([key, value]) => `${key}=${shellQuote(value)}`),
        [binary, ...args].map(shellQuote).join(" "),
      ].join(" ")

    tmux(["new-session", "-d", "-s", tmuxName, "-n", "server", envCommand(root, ["serve", "--hostname", "127.0.0.1", "--port", String(serverPort)])])
    await waitFor(
      async () => (await fetch(`${serverURL}/api/info`, { headers: auth(password) }).catch(() => undefined))?.ok === true,
      "OpenCode server did not start",
    )

    const history = await createSession(serverURL, password, workspaceHistory)
    await sendPrompt(serverURL, password, history.id, "history-search-needle from another session")
    const current = await createSession(serverURL, password, workspaceCurrent)

    tmux(["new-window", "-t", tmuxName, "-n", "tui"])
    await Bun.sleep(1_000)
    tmux(["send-keys", "-t", `${tmuxName}:tui`, envCommand(workspaceCurrent, ["--server", serverURL, "--session", current.id]), "Enter"])
    await waitForPane(`${tmuxName}:tui`, "Prompt-Search-E2e", "TUI did not start")
    await Bun.sleep(1_500)

    tmux(["send-keys", "-t", `${tmuxName}:tui`, "F12"])
    await waitForPane(`${tmuxName}:tui`, "Search previous prompts", "prompt search dialog did not open")
    tmux(["send-keys", "-t", `${tmuxName}:tui`, "history-search-needle"])
    await waitForPane(`${tmuxName}:tui`, "history-search-needle", "prompt search did not filter the previous prompt")
    tmux(["send-keys", "-t", `${tmuxName}:tui`, "Enter"])

    const expected = "history-search-needle from another session"
    const delivered = await waitFor(async () => {
      const exported = await api<{ data: { messages: Array<Record<string, any>> } }>(
        serverURL,
        password,
        `/api/experimental/session/${current.id}/export`,
      )
      return exported.data.messages.find((message) => message.type === "user" && message.text === expected) ?? false
    }, "selected previous prompt was not queued into the current session")

    expect(delivered).toMatchObject({ type: "user", text: expected })
    expect(proxy.requests.length).toBeGreaterThan(0)
  } finally {
    tmux(["kill-session", "-t", tmuxName], false)
    proxy.close()
    await rm(root, { recursive: true, force: true })
  }
})

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
  const requests: Array<{ body: unknown }> = []
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      if (request.method !== "POST" || !new URL(request.url).pathname.endsWith("/chat/completions"))
        return new Response("not found", { status: 404 })
      const body = (await request.json()) as { model?: string }
      requests.push({ body })
      const id = `chatcmpl-${crypto.randomUUID()}`
      const created = Math.floor(Date.now() / 1000)
      const chunks = [
        {
          id,
          object: "chat.completion.chunk",
          created,
          model: body.model ?? "test-model",
          choices: [{ index: 0, delta: { role: "assistant", content: "E2E_OK" }, finish_reason: null }],
        },
        {
          id,
          object: "chat.completion.chunk",
          created,
          model: body.model ?? "test-model",
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        },
      ]
      return new Response(chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n", {
        headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
      })
    },
  })
  return { baseURL: `${server.url}v1`, requests, close: () => server.stop(true) }
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

function tmux(args: string[], throwOnFailure = true) {
  const result = Bun.spawnSync(["tmux", ...args], { stdout: "pipe", stderr: "pipe" })
  if (throwOnFailure && result.exitCode !== 0)
    throw new Error(`tmux ${args.join(" ")} failed: ${new TextDecoder().decode(result.stderr)}`)
  return result
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
