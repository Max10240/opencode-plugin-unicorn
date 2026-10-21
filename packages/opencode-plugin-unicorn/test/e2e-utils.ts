import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import { LLMock } from "@copilotkit/aimock"
import { parse } from "jsonc-parser"
import { e2eEnvironment } from "./e2e-environment.js"

export const DEFAULT_LOW_LIMIT = {
  context: 200_000,
  input: 200_000,
  output: 30_000,
}

export type ProxyRequest = {
  readonly kind: "compaction" | "primary"
  readonly model: string | undefined
  readonly promptTokens: number
  readonly messages: readonly unknown[]
  readonly tools: readonly string[]
}

export type MockProvider = {
  readonly baseURL: string
  readonly mock: LLMock
  readonly requests: ProxyRequest[]
  readonly imageRequests: number
  readonly imageEditRequests: number
  readonly close: () => Promise<void>
}

export type OpenCodeE2E = {
  readonly root: string
  readonly configDirectory: string
  readonly configPath: string
  readonly workspace: string
  readonly baseURL: string
  readonly proxy: MockProvider
  readonly close: () => Promise<void>
  readonly restart: () => Promise<void>
  readonly model: () => Promise<Record<string, any>>
  readonly waitForModelContext: (context: number) => Promise<Record<string, any>>
  readonly runLargePrompt: () => Promise<{
    readonly sessionID: string
    readonly messages: readonly Record<string, any>[]
  }>
  readonly runImagePrompt: (kind?: "generate" | "edit") => Promise<{
    readonly sessionID: string
    readonly messages: readonly Record<string, any>[]
  }>
  readonly config: () => Promise<Record<string, any>>
}

const SUMMARY_MARKER = "You MUST summarize the conversation above"
const PRIMARY_RESPONSE = "E2E_PRIMARY_OK"
const IMAGE_PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="
const COMPACTION_RESPONSE = `## Objective
- Verify automatic context compaction through a local proxy.

## Requirements
- Preserve the compaction boundary.

## Decisions
- Use a deterministic proxy response.

## Work State
### Completed
- Compaction request completed.
### Active
- None.
### Blocked
- None.

## Next Move
1. Return the primary response.

## Relevant Files
- (none)

## Important Context
- Deterministic E2E test.`

export async function createOpenCodeE2E(
  options: {
    readonly featureEnabled?: boolean
    readonly imageGenEnabled?: boolean
    readonly plugin?: "unicorn" | "image-gen" | "prompt-search" | "session-search" | "send-message" | "show-img" | "recommended-config"
    readonly pluginPackage?: string
    readonly pluginOptions?: Record<string, unknown>
    readonly share?: string
    readonly initialRules?: string
    readonly isMaxSelf?: string
    readonly configure?: (config: Record<string, any>) => void
    readonly beforeStart?: (paths: { root: string; configDirectory: string; configPath: string }) => Promise<void>
  } = {},
) {
  const root = await mkdtemp(path.join(os.tmpdir(), "opencode-plugin-unicorn-e2e-"))
  const configDirectory = path.join(root, "config")
  const workspace = path.join(root, "workspace")
  const configPath = path.join(configDirectory, "opencode.jsonc")
  await mkdir(configDirectory, { recursive: true })
  await mkdir(workspace, { recursive: true })

  const proxy = await startMockProvider()
  const features = options.plugin !== undefined && options.plugin !== "unicorn"
    ? {}
    : {
        ...(options.featureEnabled === undefined ? {} : { recommendedOpencodeConfig: options.featureEnabled }),
        ...(options.imageGenEnabled === undefined ? {} : { imageGen: options.imageGenEnabled }),
      }
  const pluginOptions = { ...(Object.keys(features).length === 0 ? {} : { features }), ...options.pluginOptions }
  const config = {
    $schema: "https://opencode.ai/config.json",
    plugins: [
      {
        package:
          options.pluginPackage ?? (options.plugin === "image-gen"
            ? path.resolve(import.meta.dir, "../../opencode-plugin-image-gen")
            : path.resolve(import.meta.dir, "..")),
        ...(Object.keys(pluginOptions).length === 0 ? {} : { options: pluginOptions }),
      },
    ],
    ...(options.share === undefined ? {} : { share: options.share }),
    providers: {
      openai: {
        settings: { baseURL: proxy.baseURL, apiKey: "proxy-test" },
        models: {
          "gpt-5.6-luna": {
            package: "@opencode/ai/providers/openai-compatible",
            settings: {
              baseURL: proxy.baseURL,
              apiKey: "proxy-test",
              provider: "openai",
            },
            limit: DEFAULT_LOW_LIMIT,
          },
        },
      },
    },
    compaction: {
      auto: true,
      buffer: 30_000,
      keep: { tokens: 15_000 },
    },
    agents: {
      "compaction-e2e": {
        model: "openai/gpt-5.6-luna",
        mode: "primary",
        steps: 3,
      },
    },
  }
  options.configure?.(config)
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8")
  if (options.initialRules !== undefined) await writeFile(path.join(configDirectory, "AGENTS.md"), options.initialRules)
  await options.beforeStart?.({ root, configDirectory, configPath })

  const port = await freePort()
  const password = "opencode-plugin-unicorn-e2e"
  const environment = e2eEnvironment({ root, configDirectory, password, isMaxSelf: options.isMaxSelf })
  const binary = process.env.OPENCODE_BIN ?? "opencode"
  const startServer = () => Bun.spawn([binary, "serve", "--hostname", "127.0.0.1", "--port", String(port)], {
    cwd: workspace,
    env: environment,
    stdout: "pipe",
    stderr: "pipe",
  })
  let server = startServer()
  let stdout = new Response(server.stdout).text()
  let stderr = new Response(server.stderr).text()
  const baseURL = `http://127.0.0.1:${port}`

  const stopServer = async () => {
    if (server.exitCode === null) server.kill()
    await Promise.race([server.exited, Bun.sleep(5_000)])
    if (server.exitCode === null) server.kill(9)
    await Promise.allSettled([stdout, stderr, server.exited])
  }
  const close = async () => {
    await proxy.close()
    await stopServer()
    await rm(root, { recursive: true, force: true })
  }

  const ready = () => waitFor(async () => {
    const response = await fetch(`${baseURL}/api/info`, {
      headers: authorization(password), signal: AbortSignal.timeout(1_000),
    }).catch(() => undefined)
    return response?.ok === true
  }, "OpenCode server did not start")

  const restart = async () => {
    await stopServer()
    server = startServer()
    stdout = new Response(server.stdout).text()
    stderr = new Response(server.stderr).text()
    await ready()
  }

  try {
    await ready()
  } catch (error) {
    const output = await readProcessOutput(stderr)
    await close()
    throw new Error(`${error instanceof Error ? error.message : String(error)}\n${output}`)
  }

  const api = async <T>(endpoint: string, init: RequestInit = {}): Promise<T> => {
    const response = await fetch(`${baseURL}${endpoint}`, {
      ...init,
      headers: {
        ...authorization(password),
        ...(init.body === undefined ? {} : { "content-type": "application/json" }),
        ...init.headers,
      },
    })
    const body = await response.text()
    if (!response.ok) throw new Error(`OpenCode ${init.method ?? "GET"} ${endpoint} failed (${response.status}): ${body}`)
    return body.length === 0 ? (undefined as T) : (JSON.parse(body) as T)
  }

  const model = async () => {
    const response = await api<{ data: Record<string, any>[] }>("/api/model")
    const result = response.data.find((item) => item.providerID === "openai" && item.id === "gpt-5.6-luna")
    if (!result) throw new Error(`OpenAI Luna model was not found: ${JSON.stringify(response.data)}`)
    return result
  }

  const waitForModelContext = (context: number) =>
    waitFor(async () => {
      try {
        const result = await model()
        return result.limit?.context === context ? result : false
      } catch {
        return false
      }
    }, `OpenCode model context did not become ${context}`)

  const configFile = async () => parse(await readFile(configPath, "utf8")) as Record<string, any>

  const runLargePrompt = async () => {
    const created = await api<{ data: { id: string } }>("/api/session", {
      method: "POST",
      body: JSON.stringify({
        title: "OpenCode plugin compaction E2E",
        agent: "compaction-e2e",
        model: { providerID: "openai", id: "gpt-5.6-luna" },
        location: { directory: workspace },
      }),
    })
    const sessionID = created.data.id
    await api(`/api/session/${sessionID}/prompt`, {
      method: "POST",
      body: JSON.stringify({ text: largePrompt(), delivery: "queue" }),
    })
    await api(`/api/experimental/session/${sessionID}/wait`, { method: "POST" })
    const exported = await api<{ data: { messages: Record<string, any>[] } }>(
      `/api/experimental/session/${sessionID}/export`,
    )
    return { sessionID, messages: exported.data.messages }
  }

  const runImagePrompt = async (kind: "generate" | "edit" = "generate") => {
    const created = await api<{ data: { id: string } }>("/api/session", {
      method: "POST",
      body: JSON.stringify({
        title: "OpenCode plugin image E2E",
        agent: "compaction-e2e",
        model: { providerID: "openai", id: "gpt-5.6-luna" },
        location: { directory: workspace },
      }),
    })
    const sessionID = created.data.id
    await api(`/api/session/${sessionID}/prompt`, {
      method: "POST",
      body: JSON.stringify({ text: kind === "generate" ? "E2E_IMAGE_GEN" : "E2E_IMAGE_EDIT", delivery: "queue" }),
    })
    await api(`/api/experimental/session/${sessionID}/wait`, { method: "POST" })
    const exported = await api<{ data: { messages: Record<string, any>[] } }>(
      `/api/experimental/session/${sessionID}/export`,
    )
    return { sessionID, messages: exported.data.messages }
  }

  return {
    root,
    configDirectory,
    configPath,
    workspace,
    baseURL,
    proxy,
    close,
    restart,
    model,
    waitForModelContext,
    runLargePrompt,
    runImagePrompt,
    config: configFile,
  } satisfies OpenCodeE2E
}

async function startMockProvider(): Promise<MockProvider> {
  const mock = new LLMock({ port: 0 })
  mock.on({ predicate: (request) => JSON.stringify(request.messages).includes(SUMMARY_MARKER) }, { content: COMPACTION_RESPONSE })
  mock.on({ toolCallId: "call_image_gen" }, { content: "E2E_IMAGE_OK" })
  mock.on({ toolCallId: "call_image_edit" }, { content: "E2E_IMAGE_EDIT_OK" })
  mock.on(
    { userMessage: "E2E_IMAGE_GEN", toolName: "image_gen" },
    { toolCalls: [{ id: "call_image_gen", name: "image_gen", arguments: { prompt: "E2E image", out: "e2e-image.png" } }] },
  )
  mock.on(
    { userMessage: "E2E_IMAGE_EDIT", toolName: "image_gen" },
    {
      toolCalls: [
        {
          id: "call_image_edit",
          name: "image_gen",
          arguments: { prompt: "E2E image edit", out: "e2e-edit.png", images: ["e2e-reference.png"] },
        },
      ],
    },
  )
  mock.onImage("E2E image", { image: { b64Json: IMAGE_PNG_BASE64 } })
  mock.onImage("E2E image edit", { image: { b64Json: IMAGE_PNG_BASE64 } })
  mock.on({}, { content: PRIMARY_RESPONSE })
  await mock.start()
  return {
    baseURL: `${mock.url}/v1`,
    mock,
    get requests() {
      return mock
        .getRequests()
        .filter((entry) => entry.path.endsWith("/chat/completions"))
        .map((entry) => {
          const body = entry.body as { model?: string; messages?: unknown[]; tools?: Array<{ function?: { name?: string }; name?: string }> } | null
          const messages = body?.messages ?? []
          const fixtureResponse = (entry.response.fixture as { response?: { content?: unknown } } | null)?.response
          return {
            kind: fixtureResponse?.content === COMPACTION_RESPONSE ? "compaction" : "primary",
            model: body?.model,
            promptTokens: Math.round(JSON.stringify(messages).length / 4),
            messages,
            tools: (body?.tools ?? []).map((tool) => tool.function?.name ?? tool.name).filter((name): name is string => !!name),
          } satisfies ProxyRequest
        })
    },
    get imageRequests() {
      return mock.getRequests().filter((entry) => entry.path.endsWith("/images/generations")).length
    },
    get imageEditRequests() {
      return mock.getRequests().filter((entry) => entry.path.endsWith("/images/edits")).length
    },
    close: () => mock.stop(),
  }
}

function authorization(password: string): HeadersInit {
  return { authorization: `Basic ${btoa(`opencode:${password}`)}` }
}

async function freePort() {
  const server = net.createServer()
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => resolve())
  })
  const address = server.address()
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
  if (address === null || typeof address === "string") throw new Error("Could not determine a free TCP port")
  return address.port
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

async function readProcessOutput(output: Promise<string>) {
  return (await Promise.race([output, Bun.sleep(1_000).then(() => "")])).slice(-4_000)
}

function largePrompt() {
  const lines = Array.from({ length: 8_000 }, (_, index) => {
    const number = String(index + 1).padStart(5, "0")
    return `E2E-LINE-${number} payload-${number} alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigma tau upsilon phi chi psi omega checkpoint-${number} ${"context-token ".repeat(12).trim()}`
  })
  return `Read the following large-file contents fully into context. Preserve all line boundaries.\n\nBEGIN LARGE FILE\n${lines.join("\n")}\nEND LARGE FILE`
}
