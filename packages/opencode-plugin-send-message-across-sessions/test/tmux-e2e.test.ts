import { expect, setDefaultTimeout, test } from "bun:test"
import { lstat, mkdir, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import { LLMock } from "@copilotkit/aimock"

type Mode = "standalone" | "unicorn" | "unicorn-disabled"

const hasTmux = Bun.spawnSync(["tmux", "-V"]).exitCode === 0

setDefaultTimeout(120_000)

test("sends a user-style message across different cwd sessions through tmux", async () => {
  if (!hasTmux) throw new Error("tmux is required for this E2E test")

  for (const mode of ["standalone", "unicorn", "unicorn-disabled"] as const) await runScenario(mode)
})

async function runScenario(mode: Mode) {
  const tempDirectory = process.env.OPENCODE_E2E_TMPDIR ?? path.join(os.tmpdir(), "opencode")
  await mkdir(tempDirectory, { recursive: true })
  const root = await mkdtemp(path.join(tempDirectory, `send-session-${mode}-`))
  const configDirectory = path.join(root, "config")
  const workspaceA = path.join(root, "workspace-a")
  const workspaceB = path.join(root, "workspace-b")
  const proxy = await startProxy()
  const tmuxName = `opencode-send-${mode}-${process.pid}`
  const password = "send-message-e2e"
  const serverPort = await freePort()
  const serverURL = `http://127.0.0.1:${serverPort}`

  try {
    const localPackages = await prepareLocalPluginArtifacts(root)
    await mkdir(configDirectory, { recursive: true })
    await mkdir(workspaceA, { recursive: true })
    await mkdir(workspaceB, { recursive: true })
    await mkdir(path.join(root, "tmp"), { recursive: true })
    await writeFile(
      path.join(configDirectory, "opencode.jsonc"),
      `${JSON.stringify(
        {
          $schema: "https://opencode.ai/config.json",
          plugins: [
            mode === "standalone"
              ? { package: localPackages.sendMessageAcrossSessions }
              : {
                  package: localPackages.unicorn,
                  options: {
                    features: {
                      globalConfig: false,
                      sendMessageAcrossSessions: mode !== "unicorn-disabled",
                      imageGen: false,
                    },
                  },
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
      PATH: process.env.PATH ?? "/usr/bin:/bin:/opt/homebrew/bin",
      LANG: process.env.LANG ?? "en_US.UTF-8",
      TERM: process.env.TERM ?? "xterm-256color",
      TMPDIR: path.join(root, "tmp"),
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
    const binary = process.env.OPENCODE_BIN ? path.resolve(process.env.OPENCODE_BIN) : "opencode"
    const envCommand = (cwd: string, args: string[]) =>
      [
        `cd ${shellQuote(cwd)} && env -i`,
        ...Object.entries(environment).map(([key, value]) => `${key}=${shellQuote(String(value))}`),
        [binary, ...args].map(shellQuote).join(" "),
      ].join(" ")

    tmux(["new-session", "-d", "-s", tmuxName, "-n", "server", envCommand(root, ["serve", "--hostname", "127.0.0.1", "--port", String(serverPort)])])
    await waitFor(async () => (await fetch(`${serverURL}/api/info`, { headers: auth(password) }).catch(() => undefined))?.ok === true, "OpenCode server did not start")

    const pluginID = mode === "standalone" ? "max10240.send-message-across-sessions" : "max10240.unicorn"
    // Plugin activation is location-scoped; load both cwd instances before their sessions are created.
    await waitForPlugin(serverURL, password, workspaceA, pluginID)
    await waitForPlugin(serverURL, password, workspaceB, pluginID)

    const target = await createSession(serverURL, password, workspaceB)
    const sender = await createSession(serverURL, password, workspaceA)
    const message = "hello-from-tmux-across-cwd"
    proxy.configure(target.id, message)

    if (mode === "unicorn-disabled") {
      await api(serverURL, password, `/api/session/${sender.id}/prompt`, {
        method: "POST",
        body: JSON.stringify({ text: "E2E_TOOL_PROBE", delivery: "queue" }),
      })
      await api(serverURL, password, `/api/experimental/session/${sender.id}/wait`, { method: "POST" })
      const request = proxy.mock.getRequests().find((entry) => entry.path.endsWith("/chat/completions"))
      expect(request).toBeDefined()
      const tools = (request?.body as { tools?: Array<{ function?: { name?: string }; name?: string }> } | null)?.tools ?? []
      const toolNames = tools.map((tool) => tool.function?.name ?? tool.name)
      expect(toolNames).not.toContain("list_online_sessions")
      expect(toolNames).not.toContain("send_message_across_sessions")
      return
    }

    // Start commands directly, without racing the user's interactive shell startup.
    tmux(["set-option", "-g", "remain-on-exit", "on"])
    tmux(["new-window", "-t", tmuxName, "-n", "target", envCommand(workspaceB, ["--server", serverURL, "--session", target.id])])
    tmux([
      "new-window",
      "-t",
      tmuxName,
      "-n",
      "sender",
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
    ])
    try {
      await waitForPane(`${tmuxName}:sender`, "LIST_DONE", "list_online_sessions did not complete")
    } catch (error) {
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}\nfixtures=${JSON.stringify(proxy.mock.getFixtures())}\njournal=${JSON.stringify(proxy.mock.getRequests())}`,
      )
    }

    const listedSessionsCall = await waitFor(async () => {
      const exported = await api<{ data: { messages: Array<Record<string, any>> } }>(
        serverURL,
        password,
        `/api/experimental/session/${sender.id}/export`,
      )
      const call = exported.data.messages
        .flatMap((entry) => (Array.isArray(entry.content) ? entry.content : []))
        .find((entry) => entry.type === "tool" && entry.name === "list_online_sessions")
      return call?.state?.status === "completed" ? call : false
    }, "list_online_sessions did not persist a completed result")
    const listedSessions = listedSessionsCall.state.metadata?.sessions as Array<Record<string, any>> | undefined
    expect(listedSessions?.map((session) => session.id)).toContain(target.id)
    expect(listedSessions?.find((session) => session.id === target.id)?.directory).toBe(workspaceB)

    tmux([
      "respawn-pane",
      "-k",
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

async function prepareLocalPluginArtifacts(root: string) {
  const packageSources = {
    sendMessageAcrossSessions: path.resolve(import.meta.dir, ".."),
    unicorn: path.resolve(import.meta.dir, "../../opencode-plugin-unicorn"),
    imageGen: path.resolve(import.meta.dir, "../../opencode-plugin-image-gen"),
    promptSearch: path.resolve(import.meta.dir, "../../opencode-plugin-prompt-search"),
    showImg: path.resolve(import.meta.dir, "../../opencode-plugin-show-img"),
  }
  const nodeModules = path.join(root, "node_modules")
  const artifactDirectory = path.join(root, "artifacts")
  await mkdir(artifactDirectory, { recursive: true })
  await mkdir(nodeModules, { recursive: true })

  const artifacts: Record<string, string> = {}
  for (const [key, source] of Object.entries(packageSources)) {
    const manifest = JSON.parse(await Bun.file(path.join(source, "package.json")).text()) as { name: string }
    const packed = Bun.spawnSync([process.execPath, "pm", "pack", "--destination", artifactDirectory, "--quiet"], {
      cwd: source,
      stdout: "pipe",
      stderr: "pipe",
    })
    if (packed.exitCode !== 0) {
      throw new Error(`Could not pack local plugin ${manifest.name}: ${packed.stderr.toString()}`)
    }

    const archiveName = (await readdir(artifactDirectory)).find((name) => name.startsWith(`${manifest.name.replace("@", "").replace("/", "-")}-`) && name.endsWith(".tgz"))
    if (!archiveName) throw new Error(`bun pm pack did not create an archive for ${manifest.name}`)

    const destination = path.join(nodeModules, ...manifest.name.split("/"))
    await mkdir(destination, { recursive: true })
    const extracted = Bun.spawnSync(["tar", "-xzf", path.join(artifactDirectory, archiveName), "-C", destination, "--strip-components=1"], {
      stdout: "pipe",
      stderr: "pipe",
    })
    if (extracted.exitCode !== 0) {
      throw new Error(`Could not extract local plugin ${manifest.name}: ${extracted.stderr.toString()}`)
    }
    artifacts[key] = path.join(destination, "dist")
  }

  await linkLocalRuntimeDependencies(nodeModules, Object.values(packageSources))
  return artifacts as {
    sendMessageAcrossSessions: string
    unicorn: string
    imageGen: string
    promptSearch: string
  }
}

async function linkLocalRuntimeDependencies(nodeModules: string, packageSources: string[]) {
  for (const packageRoot of packageSources) {
    const sourceNodeModules = path.join(packageRoot, "node_modules")
    for (const entry of await readdir(sourceNodeModules, { withFileTypes: true })) {
      if (entry.name === ".bin" || entry.name === "@max10240") continue

      const source = path.join(sourceNodeModules, entry.name)
      const destination = path.join(nodeModules, entry.name)
      if (entry.name.startsWith("@")) {
        await mkdir(destination, { recursive: true })
        for (const scopedEntry of await readdir(source)) {
          if (scopedEntry === "max10240") continue
          const scopedSource = path.join(source, scopedEntry)
          const scopedDestination = path.join(destination, scopedEntry)
          if (!(await pathExists(scopedDestination))) await symlink(scopedSource, scopedDestination, "dir")
        }
      } else if (!(await pathExists(destination))) {
        await symlink(source, destination, "dir")
      }
    }
  }
}

async function pathExists(target: string) {
  return lstat(target).then(
    () => true,
    () => false,
  )
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
