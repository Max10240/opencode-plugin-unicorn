import { expect, setDefaultTimeout, test } from "bun:test"
import { lstat, mkdir, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import { LLMock } from "@copilotkit/aimock"
import { packWorkspace } from "../../../scripts/test-artifacts.mjs"
import type { Archive } from "../../../scripts/test-artifacts.mjs"

type Mode = "standalone" | "unicorn" | "unicorn-disabled"

setDefaultTimeout(180_000)

test("sends a user-style message across different cwd sessions", async () => {
  const artifacts = await mkdtemp(path.join(os.tmpdir(), "send-session-archives-"))
  const shared = await mkdtemp(path.join(os.tmpdir(), "send-session-packages-"))
  try {
    const archives = await packWorkspace(artifacts)
    const localPackages = await prepareLocalPluginArtifacts(shared, archives)
    await Promise.all((["standalone", "unicorn"] as const).map((mode) => runScenario(mode, localPackages)))
  } finally { await rm(artifacts, { recursive: true, force: true }); await rm(shared, { recursive: true, force: true }) }
})

type LocalPackages = Awaited<ReturnType<typeof prepareLocalPluginArtifacts>>

async function runScenario(mode: Mode, localPackages: LocalPackages) {
  const tempDirectory = process.env.OPENCODE_E2E_TMPDIR ?? path.join(os.tmpdir(), "opencode")
  await mkdir(tempDirectory, { recursive: true })
  const root = await mkdtemp(path.join(tempDirectory, `send-session-${mode}-`))
  const configDirectory = path.join(root, "config")
  const workspaceA = path.join(root, "workspace-a")
  const workspaceB = path.join(root, "workspace-b")
  const proxy = await startProxy()
  const password = "send-message-e2e"
  const serverPort = await freePort()
  const serverURL = `http://127.0.0.1:${serverPort}`
  let server: ReturnType<typeof Bun.spawn> | undefined

  try {
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
                      recommendedOpencodeConfig: false,
                      sendMessageAcrossSessions: mode !== "unicorn-disabled",
                      imageGen: false,
                    },
                  },
                },
          ],
          providers: {
            test: {
              name: "headless E2E provider",
              package: "@opencode/ai/providers/openai-compatible",
              settings: { baseURL: proxy.baseURL, apiKey: "headless-e2e", provider: "test" },
              models: { "test-model": { name: "headless E2E model", limit: { context: 200_000, output: 4_000 } } },
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
    server = Bun.spawn([binary, "serve", "--hostname", "127.0.0.1", "--port", String(serverPort)], {
      cwd: root,
      env: environment,
      stdout: "pipe",
      stderr: "pipe",
    })
    try {
      await waitFor(async () => (await fetch(`${serverURL}/api/info`, { headers: auth(password) }).catch(() => undefined))?.ok === true, "OpenCode server did not start")
    } catch (error) {
      const stderr = await new Response(server.stderr as ReadableStream<Uint8Array>).text()
      throw new Error(`${error instanceof Error ? error.message : String(error)}\n${stderr}`)
    }

    const run = async (cwd: string, args: string[]) => {
      const process = Bun.spawn([binary, ...args], { cwd, env: environment, stdout: "pipe", stderr: "pipe" })
      const [exitCode, stdout, stderr] = await Promise.all([process.exited, new Response(process.stdout).text(), new Response(process.stderr).text()])
      if (exitCode !== 0) throw new Error(`${args.join(" ")} failed (${exitCode})\n${stdout}\n${stderr}`)
      return stdout
    }

    const pluginID = mode === "standalone" ? "max10240.send-message-across-sessions" : "max10240.unicorn"
    // Plugin activation is location-scoped; load both cwd instances before their sessions are created.
    await Promise.all([
      waitForPlugin(serverURL, password, workspaceA, pluginID),
      waitForPlugin(serverURL, password, workspaceB, pluginID),
    ])

    const target = await createSession(serverURL, password, workspaceB)
    const sender = await createSession(serverURL, password, workspaceA)
    const steerMessage = "steer-marker-across-cwd"
    const queueMessage = "queue-marker-across-cwd"
    proxy.configure(target.id, steerMessage, queueMessage)

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

    const steerSender = await createSession(serverURL, password, workspaceA)
    const queueSender = await createSession(serverURL, password, workspaceA)

    await run(workspaceA, [
      "run",
      "--server", serverURL,
      "--format", "json",
      "--model", "test/test-model",
      "--session", sender.id,
      "E2E_LIST_SESSIONS",
    ])

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

    // Keep the target busy so both messages remain pending and their delivery modes are observable.
    await api(serverURL, password, `/api/session/${target.id}/prompt`, {
      method: "POST",
      body: JSON.stringify({ text: "E2E_TARGET_BUSY", delivery: "queue" }),
    })
    await waitFor(
      async () => proxy.mock.getRequests().some((entry) => JSON.stringify(entry.body).includes("E2E_TARGET_BUSY")),
      "target session did not start its busy turn",
    )

    const sendFromSender = async (sessionID: string, prompt: string) => {
      await run(workspaceA, [
        "run",
        "--server", serverURL,
        "--format", "json",
        "--model", "test/test-model",
        "--session", sessionID,
        prompt,
      ])
    }

    await sendFromSender(steerSender.id, `E2E_SEND_STEER target=${target.id} message=${steerMessage}`)
    await sendFromSender(queueSender.id, `E2E_SEND_QUEUE target=${target.id} message=${queueMessage}`)

    const pending = await waitFor(async () => {
      const inbox = await api<{ data: Array<{ type: string; delivery: string }> }>(
        serverURL,
        password,
        `/api/session/${target.id}/inbox`,
      )
      const userItems = inbox.data.filter((item) => item.type === "user")
      const deliveries = userItems.map((item) => item.delivery)
      return deliveries.includes("steer") && deliveries.includes("queue") ? userItems : false
    }, "target inbox did not keep both delivery modes pending")
    expect(pending.map((item) => item.delivery).sort()).toEqual(["queue", "steer"])

    // Release the target's tool call only after both delivery modes are queued.
    await writeFile(path.join(workspaceB, "target-busy.marker"), "ready")

    const expectedSteer = `Message from <${steerSender.id}>: ${steerMessage}`
    const expectedQueue = `Message from <${queueSender.id}>: ${queueMessage}`
    try {
      await waitFor(async () => {
        const exported = await api<{ data: { messages: Array<Record<string, any>> } }>(
          serverURL,
          password,
          `/api/experimental/session/${target.id}/export`,
        )
        const texts = exported.data.messages.filter((item) => item.type === "user").map((item) => item.text)
        return texts.includes(expectedSteer) && texts.includes(expectedQueue)
      }, "target session did not receive both prefixed user messages", 60_000)
    } catch (error) {
      const exported = await api<{ data: { messages: Array<Record<string, any>> } }>(
        serverURL,
        password,
        `/api/experimental/session/${target.id}/export`,
      )
      const inbox = await api<{ data: Array<Record<string, any>> }>(
        serverURL,
        password,
        `/api/session/${target.id}/inbox`,
      )
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}\njournal=${JSON.stringify(proxy.mock.getRequests())}\ntarget=${JSON.stringify(exported.data.messages)}\ninbox=${JSON.stringify(inbox.data)}`,
      )
    }

    const deliveryOrder = () => {
      const bodies = proxy.mock.getRequests().map((entry) => JSON.stringify(entry.body))
      const targetRequest = (marker: string) =>
        bodies.findIndex(
          (body) => !body.includes("E2E_SEND_") && !body.includes("E2E_LIST_SESSIONS") && body.includes(marker),
        )
      return { bodies, initial: targetRequest("E2E_TARGET_BUSY"), steered: targetRequest(steerMessage), queued: targetRequest(queueMessage) }
    }
    await waitFor(async () => {
      const { bodies, initial, steered, queued } = deliveryOrder()
      return initial >= 0 && steered > initial && queued > steered &&
        !bodies[steered].includes(queueMessage) && bodies[queued].includes(steerMessage)
    }, "delivery request order did not settle", 60_000)
    const { bodies, initial, steered, queued } = deliveryOrder()
    // steer is promoted at the next step boundary, while queue waits for the turn to end.
    expect(initial).toBeGreaterThanOrEqual(0)
    expect(steered).toBeGreaterThan(initial)
    expect(queued).toBeGreaterThan(steered)
    expect(bodies[steered]).not.toContain(queueMessage)
    expect(bodies[queued]).toContain(steerMessage)
  } finally {
    await writeFile(path.join(workspaceB, "target-busy.marker"), "cleanup").catch(() => {})
    if (server?.exitCode === null) {
      server.kill()
      await server.exited
    }
    await proxy.close()
    await rm(root, { recursive: true, force: true })
  }
}

async function prepareLocalPluginArtifacts(root: string, archives: Archive[]) {
  const packageSources = {
    sendMessageAcrossSessions: path.resolve(import.meta.dir, ".."),
    unicorn: path.resolve(import.meta.dir, "../../opencode-plugin-unicorn"),
    god: path.resolve(import.meta.dir, "../../opencode-plugin-god"),
    imageGen: path.resolve(import.meta.dir, "../../opencode-plugin-image-gen"),
    notepad: path.resolve(import.meta.dir, "../../opencode-plugin-notepad"),
    promptSearch: path.resolve(import.meta.dir, "../../opencode-plugin-prompt-search"),
    sessionSearch: path.resolve(import.meta.dir, "../../opencode-plugin-session-search"),
    showImg: path.resolve(import.meta.dir, "../../opencode-plugin-show-img"),
    opencodeGoUsage: path.resolve(import.meta.dir, "../../opencode-plugin-opencode-go-usage"),
    sensitiveEncrypt: path.resolve(import.meta.dir, "../../opencode-plugin-sensitive-encrypt"),
    sensitiveProtection: path.resolve(import.meta.dir, "../../opencode-plugin-sensitive-protection"),
    recommendedConfig: path.resolve(import.meta.dir, "../../opencode-plugin-recomended-opencode-config"),
    infiniteLoop: path.resolve(import.meta.dir, "../../opencode-plugin-infinite-loop"),
    delayedQueue: path.resolve(import.meta.dir, "../../opencode-plugin-delayed-queue"),
  }
  const nodeModules = path.join(root, "node_modules")
  await mkdir(nodeModules, { recursive: true })

  const artifacts: Record<string, string> = {}
  for (const [key, source] of Object.entries(packageSources)) {
    const manifest = JSON.parse(await Bun.file(path.join(source, "package.json")).text()) as { name: string }
    const archive = archives.find((item) => item.manifest.name === manifest.name)
    if (!archive) throw new Error(`Missing test archive for ${manifest.name}`)

    const destination = path.join(nodeModules, ...manifest.name.split("/"))
    await mkdir(destination, { recursive: true })
    const extracted = Bun.spawnSync(["tar", "-xzf", archive.file, "-C", destination, "--strip-components=1"], {
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
    god: string
    imageGen: string
    notepad: string
    promptSearch: string
    showImg: string
    opencodeGoUsage: string
    sensitiveEncrypt: string
    sensitiveProtection: string
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
    configure(targetID: string, steerMessage: string, queueMessage: string) {
      mock.on(
        { toolCallId: "call_list_sessions" },
        { content: "LIST_DONE" },
      )
      mock.on(
        { userMessage: "E2E_LIST_SESSIONS" },
        { toolCalls: [{ id: "call_list_sessions", name: "list_online_sessions", arguments: {} }] },
      )
      mock.on({ toolCallId: "call_send_steer" }, { content: "SEND_STEER_DONE" })
      mock.on(
        { userMessage: "E2E_SEND_STEER" },
        {
          toolCalls: [
            {
              id: "call_send_steer",
              name: "send_message_across_sessions",
              arguments: { target_session_id: targetID, message: steerMessage, "need-reply": false },
            },
          ],
        },
      )
      mock.on({ toolCallId: "call_send_queue" }, { content: "SEND_QUEUE_DONE" })
      mock.on(
        { userMessage: "E2E_SEND_QUEUE" },
        {
          toolCalls: [
            {
              id: "call_send_queue",
              name: "send_message_across_sessions",
              arguments: { target_session_id: targetID, message: queueMessage, "need-reply": false, delivery: "queue" },
            },
          ],
        },
      )
      mock.on(
        { userMessage: "E2E_TARGET_BUSY", sequenceIndex: 0 },
        {
          toolCalls: [
            {
              id: "call_target_wait",
              name: "shell",
              arguments: {
                command: "for i in {1..300}; do [ -f target-busy.marker ] && break; sleep 0.1; done",
              },
            },
          ],
        },
      )
      mock.on({ predicate: (request) => JSON.stringify(request.messages).includes("Message from <") }, { content: "TARGET_RECEIVED" })
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

async function waitFor<T>(check: () => Promise<T | false>, message: string, timeout = 30_000): Promise<T> {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const result = await check()
    if (result !== false) return result
    await Bun.sleep(25)
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
