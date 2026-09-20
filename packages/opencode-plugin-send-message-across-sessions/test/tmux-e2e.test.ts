import { expect, setDefaultTimeout, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import net from "node:net"
import os from "node:os"
import path from "node:path"

type Mode = "standalone" | "unicorn"

const hasTmux = Bun.spawnSync(["tmux", "-V"]).exitCode === 0

setDefaultTimeout(120_000)

test("sends a user-style message across different cwd sessions through tmux", async () => {
  if (!hasTmux) throw new Error("tmux is required for this E2E test")

  for (const mode of ["standalone", "unicorn"] as const) await runScenario(mode)
})

async function runScenario(mode: Mode) {
  const root = await mkdtemp(path.join(os.tmpdir(), `opencode-send-session-${mode}-`))
  const configDirectory = path.join(root, "config")
  const workspaceA = path.join(root, "workspace-a")
  const workspaceB = path.join(root, "workspace-b")
  const proxy = await startProxy()
  const tmuxName = `opencode-send-${mode}-${process.pid}`
  const password = "send-message-e2e"
  const serverPort = await freePort()
  const serverURL = `http://127.0.0.1:${serverPort}`
  const pluginRoot = path.resolve(import.meta.dir, "..")
  const unicornRoot = path.resolve(import.meta.dir, "../../opencode-plugin-unicorn")

  try {
    await mkdir(configDirectory, { recursive: true })
    await mkdir(workspaceA, { recursive: true })
    await mkdir(workspaceB, { recursive: true })
    await writeFile(
      path.join(configDirectory, "opencode.jsonc"),
      `${JSON.stringify(
        {
          $schema: "https://opencode.ai/config.json",
          plugins: [
            mode === "standalone"
              ? { package: pluginRoot }
              : {
                  package: unicornRoot,
                  options: { features: { globalConfig: false, sendMessageAcrossSessions: true } },
                },
          ],
          providers: {
            test: {
              name: "tmux E2E provider",
              package: "@opencode/ai/providers/openai-compatible",
              settings: { baseURL: proxy.baseURL, apiKey: "tmux-e2e", provider: "test" },
              models: { "test-model": { name: "tmux E2E model", limit: { context: 200_000, output: 4_000 } } },
            },
          },
          agents: {
            "send-message-e2e": { model: "test/test-model", mode: "primary", steps: 3 },
          },
        },
        null,
        2,
      )}\n`,
    )

    const environment = {
      OPENCODE_CONFIG_DIR: configDirectory,
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
        ...Object.entries(environment).map(([key, value]) => `${key}=${shellQuote(String(value))}`),
        [binary, ...args].map(shellQuote).join(" "),
      ].join(" ")

    tmux(["new-session", "-d", "-s", tmuxName, "-n", "server", envCommand(root, ["serve", "--hostname", "127.0.0.1", "--port", String(serverPort)])])
    await waitFor(async () => (await fetch(`${serverURL}/api/info`, { headers: auth(password) }).catch(() => undefined))?.ok === true, "OpenCode server did not start")

    // Activate the location plugin before creating sessions so the event watcher sees both session.created events.
    await api(serverURL, password, "/api/model")
    await Bun.sleep(500)

    const target = await createSession(serverURL, password, workspaceB)
    const sender = await createSession(serverURL, password, workspaceA)
    const pluginID = mode === "standalone" ? "max10240.send-message-across-sessions" : "max10240.unicorn"
    await waitForPlugin(serverURL, password, workspaceA, pluginID)
    await waitForPlugin(serverURL, password, workspaceB, pluginID)

    tmux(["new-window", "-t", tmuxName, "-n", "target"])
    await Bun.sleep(1_000)
    tmux([
      "send-keys",
      "-t",
      `${tmuxName}:target`,
      envCommand(workspaceB, ["--server", serverURL, "--session", target.id]),
      "Enter",
    ])
    await Bun.sleep(1_500)

    tmux(["new-window", "-t", tmuxName, "-n", "sender"])
    await Bun.sleep(1_000)
    tmux([
      "send-keys",
      "-t",
      `${tmuxName}:sender`,
      envCommand(workspaceA, [
        "run",
        "--server",
        serverURL,
        "--format",
        "json",
        "--model",
        "test/test-model",
        "--session",
        sender.id,
        "E2E_LIST_SESSIONS",
      ]),
      "Enter",
    ])
    await waitForPane(`${tmuxName}:sender`, "LIST_DONE", "list_online_sessions did not complete")

    const message = "hello-from-tmux-across-cwd"
    tmux([
      "send-keys",
      "-t",
      `${tmuxName}:sender`,
      envCommand(workspaceA, [
        "run",
        "--server",
        serverURL,
        "--format",
        "json",
        "--model",
        "test/test-model",
        "--session",
        sender.id,
        `E2E_SEND_MESSAGE target=${target.id} message=${message}`,
      ]),
      "Enter",
    ])
    await waitForPane(`${tmuxName}:sender`, "SEND_DONE", "send_message_across_sessions did not complete")

    const expected = `来自<${sender.id}>的消息: ${message}`
    let delivered: Record<string, any>
    try {
      delivered = await waitFor(async () => {
        const exported = await api<{ data: { messages: Array<Record<string, any>> } }>(
          serverURL,
          password,
          `/api/experimental/session/${target.id}/export`,
        )
        return exported.data.messages.find((item) => item.type === "user" && item.text === expected) ?? false
      }, "target session did not receive the prefixed user message")
    } catch (error) {
      const exported = await api<{ data: { messages: Array<Record<string, any>> } }>(
        serverURL,
        password,
        `/api/experimental/session/${target.id}/export`,
      )
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}\ncalls=${JSON.stringify(proxy.calls)}\ntarget=${JSON.stringify(exported.data.messages)}`,
      )
    }

    expect(delivered).toMatchObject({ type: "user", text: expected })
    expect(proxy.calls.some((call) => call.name === "list_online_sessions")).toBe(true)
    expect(proxy.calls.some((call) => call.name === "send_message_across_sessions")).toBe(true)
    expect(proxy.calls.some((call) => call.name === "tool-result" && call.arguments.includes(target.id))).toBe(true)
  } finally {
    tmux(["kill-session", "-t", tmuxName], false)
    proxy.close()
    await rm(root, { recursive: true, force: true })
  }
}

async function waitForPlugin(serverURL: string, password: string, directory: string, pluginID: string) {
  await waitFor(async () => {
    const response = await api<{ data: Array<{ id: string; state: { status: string } }> }>(
      serverURL,
      password,
      `/api/plugin?directory=${encodeURIComponent(directory)}`,
    )
    return response.data.some((plugin) => plugin.id === pluginID && plugin.state.status === "active") || false
  }, `plugin ${pluginID} did not activate for ${directory}`)
}

async function createSession(serverURL: string, password: string, directory: string) {
  const response = await api<{ data: { id: string; location: { directory: string } } }>(serverURL, password, "/api/session", {
    method: "POST",
    body: JSON.stringify({
      title: path.basename(directory),
      agent: "send-message-e2e",
      model: { providerID: "test", id: "test-model" },
      location: { directory },
    }),
  })
  return response.data
}

async function startProxy() {
  const calls: Array<{ name: string; arguments: string; result?: string; availableTools?: string[] }> = []
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      if (request.method !== "POST" || !new URL(request.url).pathname.endsWith("/chat/completions"))
        return new Response("not found", { status: 404 })
      const body = (await request.json()) as { model?: string; messages?: Array<Record<string, any>> }
      const messages = body.messages ?? []
      const serialized = JSON.stringify(messages)
      const userMessages = messages
        .filter((item) => item.role === "user")
        .map((item) => (typeof item.content === "string" ? item.content : JSON.stringify(item.content)))
      const userText = userMessages.at(-1) ?? ""
      const reversedUserIndex = [...messages].reverse().findIndex((item) => item.role === "user")
      const lastUserIndex = reversedUserIndex < 0 ? -1 : messages.length - 1 - reversedUserIndex
      const hasToolResult = messages.slice(lastUserIndex + 1).some((item) => item.role === "tool")
      const availableTools = Array.isArray((body as any).tools)
        ? (body as any).tools.map((tool: any) => tool.function?.name ?? tool.name).filter(Boolean)
        : []
      if (hasToolResult) {
        calls.push({
          name: "tool-result",
          arguments: JSON.stringify(messages.filter((item) => item.role === "tool").at(-1)?.content),
          result: "tool-result",
          availableTools,
        })
      }
      let toolName: string | undefined
      let toolArguments = "{}"
      let finalText = "READY"
      if (!hasToolResult && userText.includes("E2E_LIST_SESSIONS")) {
        toolName = "list_online_sessions"
        toolArguments = "{}"
        finalText = "LIST_DONE"
      } else if (!hasToolResult && userText.includes("E2E_SEND_MESSAGE")) {
        const target = userText.match(/target=(\S+)/)?.[1]
        const message = userText.match(/message=([^\s"]+)/)?.[1]
        toolName = "send_message_across_sessions"
        toolArguments = JSON.stringify({ target_session_id: target, message })
        finalText = "SEND_DONE"
      } else if (serialized.includes("来自<")) {
        finalText = "TARGET_RECEIVED"
      } else if (hasToolResult) {
        finalText = userText.includes("E2E_LIST_SESSIONS") ? "LIST_DONE" : "SEND_DONE"
      }

      if (toolName) {
        calls.push({ name: toolName, arguments: toolArguments, availableTools })
        return streamResponse(body, {
          toolName,
          toolArguments,
          text: "",
          finishReason: "tool_calls",
        })
      }
      return streamResponse(body, { text: finalText, finishReason: "stop" })
    },
  })
  return {
    baseURL: `${server.url}v1`,
    calls,
    close: () => server.stop(true),
  }
}

function streamResponse(
  body: { model?: string },
  input: { text: string; finishReason: "stop" | "tool_calls"; toolName?: string; toolArguments?: string },
) {
  const id = `chatcmpl-${crypto.randomUUID()}`
  const created = Math.floor(Date.now() / 1000)
  const delta = input.toolName
    ? {
        role: "assistant",
        tool_calls: [
          {
            index: 0,
            id: `call-${crypto.randomUUID()}`,
            type: "function",
            function: { name: input.toolName, arguments: input.toolArguments ?? "{}" },
          },
        ],
      }
    : { role: "assistant", content: input.text }
  const chunks = [
    { id, object: "chat.completion.chunk", created, model: body.model ?? "test-model", choices: [{ index: 0, delta, finish_reason: null }] },
    { id, object: "chat.completion.chunk", created, model: body.model ?? "test-model", choices: [{ index: 0, delta: {}, finish_reason: input.finishReason }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } },
  ]
  return new Response(chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n", {
    headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
  })
}

async function api<T>(baseURL: string, password: string, endpoint: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${baseURL}${endpoint}`, {
    ...init,
    headers: { ...auth(password), ...(init.body === undefined ? {} : { "content-type": "application/json" }), ...init.headers },
  })
  const text = await response.text()
  if (!response.ok) throw new Error(`${init.method ?? "GET"} ${endpoint} failed: ${response.status} ${text}`)
  return JSON.parse(text) as T
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

async function waitFor<T>(check: () => Promise<T | false>, message: string, timeout = 30_000): Promise<T> {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const result = await check()
    if (result !== false) return result
    await Bun.sleep(100)
  }
  throw new Error(message)
}

async function waitForPane(target: string, text: string, message: string) {
  try {
    return await waitFor(
      async () => tmux(["capture-pane", "-p", "-t", target], false).stdout.toString().includes(text) || false,
      message,
    )
  } catch (error) {
    const output = tmux(["capture-pane", "-p", "-t", target], false).stdout.toString()
    throw new Error(`${error instanceof Error ? error.message : String(error)}\n--- ${target} ---\n${output}`)
  }
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
