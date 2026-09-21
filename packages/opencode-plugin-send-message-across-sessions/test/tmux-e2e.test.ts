import { expect, setDefaultTimeout, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import { LLMock } from "@copilotkit/aimock"

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
    const message = "hello-from-tmux-across-cwd"
    proxy.configure(target.id, message)

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
    try {
      await waitForPane(`${tmuxName}:sender`, "LIST_DONE", "list_online_sessions did not complete")
    } catch (error) {
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}\nfixtures=${JSON.stringify(proxy.mock.getFixtures())}\njournal=${JSON.stringify(proxy.mock.getRequests())}`,
      )
    }

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
        `${error instanceof Error ? error.message : String(error)}\njournal=${JSON.stringify(proxy.mock.getRequests())}\ntarget=${JSON.stringify(exported.data.messages)}`,
      )
    }

    expect(delivered).toMatchObject({ type: "user", text: expected })
    const journal = proxy.mock.getRequests()
    expect(journal.some((entry) => JSON.stringify(entry.body).includes("E2E_LIST_SESSIONS"))).toBe(true)
    expect(journal.some((entry) => JSON.stringify(entry.body).includes("E2E_SEND_MESSAGE"))).toBe(true)
  } finally {
    tmux(["kill-session", "-t", tmuxName], false)
    await proxy.close()
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
  const mock = new LLMock({ port: 0 })
  await mock.start()
  return {
    baseURL: `${mock.url}/v1`,
    mock,
    configure(targetID: string, message: string) {
      mock.on(
        { toolCallId: "call_list_sessions" },
        { content: "LIST_DONE" },
      )
      mock.on(
        { userMessage: "E2E_LIST_SESSIONS" },
        { toolCalls: [{ id: "call_list_sessions", name: "list_online_sessions", arguments: {} }] },
      )
      mock.on(
        { toolCallId: "call_send_message" },
        { content: "SEND_DONE" },
      )
      mock.on(
        { userMessage: "E2E_SEND_MESSAGE" },
        {
          toolCalls: [
            {
              id: "call_send_message",
              name: "send_message_across_sessions",
              arguments: { target_session_id: targetID, message },
            },
          ],
        },
      )
      mock.on({ predicate: (request) => JSON.stringify(request.messages).includes("来自<") }, { content: "TARGET_RECEIVED" })
      mock.on({}, { content: "READY" })
    },
    close: () => mock.stop(),
  }
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
