import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import { parse } from "jsonc-parser"

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
  readonly requests: ProxyRequest[]
  readonly imageRequests: number
  readonly close: () => void
}

export type OpenCodeE2E = {
  readonly root: string
  readonly configDirectory: string
  readonly configPath: string
  readonly workspace: string
  readonly baseURL: string
  readonly proxy: MockProvider
  readonly close: () => Promise<void>
  readonly model: () => Promise<Record<string, any>>
  readonly waitForModelContext: (context: number) => Promise<Record<string, any>>
  readonly runLargePrompt: () => Promise<{
    readonly sessionID: string
    readonly messages: readonly Record<string, any>[]
  }>
  readonly runImagePrompt: () => Promise<{
    readonly sessionID: string
    readonly messages: readonly Record<string, any>[]
  }>
  readonly config: () => Promise<Record<string, any>>
}

const SUMMARY_MARKER = "You MUST summarize the conversation above"
const PRIMARY_RESPONSE = "E2E_PRIMARY_OK"
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
  options: { readonly featureEnabled?: boolean; readonly imageGenEnabled?: boolean; readonly share?: string } = {},
) {
  const root = await mkdtemp(path.join(os.tmpdir(), "opencode-plugin-unicorn-e2e-"))
  const configDirectory = path.join(root, "config")
  const workspace = path.join(root, "workspace")
  const configPath = path.join(configDirectory, "opencode.jsonc")
  await mkdir(configDirectory, { recursive: true })
  await mkdir(workspace, { recursive: true })

  const proxy = await startMockProvider()
  const features = {
    ...(options.featureEnabled === undefined ? {} : { globalConfig: options.featureEnabled }),
    ...(options.imageGenEnabled === undefined ? {} : { imageGen: options.imageGenEnabled }),
  }
  const config = {
    $schema: "https://opencode.ai/config.json",
    plugins: [
      {
        package: path.resolve(import.meta.dir, ".."),
        ...(Object.keys(features).length === 0 ? {} : { options: { features } }),
      },
    ],
    ...(options.share === undefined ? {} : { share: options.share }),
    providers: {
      openai: {
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
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8")

  const port = await freePort()
  const password = "opencode-plugin-unicorn-e2e"
  const environment = {
    ...process.env,
    OPENCODE_CONFIG_DIR: configDirectory,
    OPENCODE_CONFIG_PROJECT_DISABLE: "1",
    OPENCODE_DB: path.join(root, "opencode.db"),
    OPENCODE_DISABLE_MODELS_FETCH: "1",
    OPENAI_API_KEY: "e2e-image-key",
    OPENCODE_PASSWORD: password,
    OPENCODE_TEST_HOME: root,
    HOME: root,
    XDG_CONFIG_HOME: path.join(root, "xdg-config"),
    XDG_DATA_HOME: path.join(root, "xdg-data"),
    XDG_CACHE_HOME: path.join(root, "xdg-cache"),
    XDG_STATE_HOME: path.join(root, "xdg-state"),
  }
  const binary = process.env.OPENCODE_BIN ?? "opencode"
  const server = Bun.spawn([binary, "serve", "--hostname", "127.0.0.1", "--port", String(port)], {
    cwd: workspace,
    env: environment,
    stdout: "pipe",
    stderr: "pipe",
  })
  const stdout = new Response(server.stdout).text()
  const stderr = new Response(server.stderr).text()
  const baseURL = `http://127.0.0.1:${port}`

  const close = async () => {
    proxy.close()
    if (server.exitCode === null) server.kill()
    await Promise.race([server.exited, Bun.sleep(5_000)])
    if (server.exitCode === null) server.kill(9)
    await Promise.allSettled([stdout, stderr, server.exited])
    await rm(root, { recursive: true, force: true })
  }

  try {
    await waitFor(async () => {
      const response = await fetch(`${baseURL}/api/info`, { headers: authorization(password) }).catch(() => undefined)
      return response?.ok === true
    }, "OpenCode server did not start")
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

  const runImagePrompt = async () => {
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
      body: JSON.stringify({ text: "E2E_IMAGE_GEN", delivery: "queue" }),
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
    model,
    waitForModelContext,
    runLargePrompt,
    runImagePrompt,
    config: configFile,
  } satisfies OpenCodeE2E
}

async function startMockProvider(): Promise<MockProvider> {
  const requests: ProxyRequest[] = []
  let imageRequests = 0
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const pathname = new URL(request.url).pathname
      if (request.method === "POST" && pathname.endsWith("/images/generations")) {
        imageRequests += 1
        await request.json()
        return Response.json({
          created: Math.floor(Date.now() / 1000),
          data: [{ b64_json: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=" }],
        })
      }
      if (request.method !== "POST" || !pathname.endsWith("/chat/completions"))
        return new Response("not found", { status: 404 })

      const body = (await request.json()) as {
        model?: string
        messages?: unknown[]
        stream?: boolean
        tools?: Array<{ function?: { name?: string }; name?: string }>
      }
      const messages = body.messages ?? []
      const serialized = JSON.stringify(messages)
      const isCompaction = serialized.includes(SUMMARY_MARKER)
      const userText = messages
        .filter((item: any) => item.role === "user")
        .map((item: any) => (typeof item.content === "string" ? item.content : JSON.stringify(item.content)))
        .at(-1) ?? ""
      const hasToolResult = messages.some((item: any) => item.role === "tool")
      const hasImageTool = (body.tools ?? []).some((tool) => (tool.function?.name ?? tool.name) === "image_gen")
      const imageToolCall = userText.includes("E2E_IMAGE_GEN") && hasImageTool && !hasToolResult
      requests.push({
        kind: isCompaction ? "compaction" : "primary",
        model: body.model,
        promptTokens: Math.round(serialized.length / 4),
        messages,
        tools: (body.tools ?? []).map((tool) => tool.function?.name ?? tool.name).filter((name): name is string => !!name),
      })

      const toolCall = imageToolCall
        ? {
            id: `call-${crypto.randomUUID()}`,
            type: "function" as const,
            function: { name: "image_gen", arguments: JSON.stringify({ prompt: "E2E image", out: "e2e-image.png" }) },
          }
        : undefined

      if (body.stream === false) {
        return Response.json({
          id: `chatcmpl-${crypto.randomUUID()}`,
          object: "chat.completion",
          created: Math.floor(Date.now() / 1000),
          model: body.model ?? "gpt-5.6-luna",
          choices: [{
            index: 0,
            message: {
              role: "assistant",
              content: toolCall ? null : isCompaction ? COMPACTION_RESPONSE : userText.includes("E2E_IMAGE_GEN") ? "E2E_IMAGE_OK" : PRIMARY_RESPONSE,
              ...(toolCall ? { tool_calls: [toolCall] } : {}),
            },
            finish_reason: toolCall ? "tool_calls" : "stop",
          }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        })
      }

      const id = `chatcmpl-${crypto.randomUUID()}`
      const created = Math.floor(Date.now() / 1000)
      const text = isCompaction ? COMPACTION_RESPONSE : userText.includes("E2E_IMAGE_GEN") ? "E2E_IMAGE_OK" : PRIMARY_RESPONSE
      const firstDelta = toolCall
        ? { role: "assistant", tool_calls: [{ index: 0, ...toolCall }] }
        : { role: "assistant", content: text }
      const chunks = [
        {
          id,
          object: "chat.completion.chunk",
          created,
          model: body.model ?? "gpt-5.6-luna",
          choices: [{ index: 0, delta: firstDelta, finish_reason: null }],
        },
        {
          id,
          object: "chat.completion.chunk",
          created,
          model: body.model ?? "gpt-5.6-luna",
          choices: [{ index: 0, delta: {}, finish_reason: toolCall ? "tool_calls" : "stop" }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        },
      ]
      const bodyText = chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n"
      return new Response(bodyText, {
        headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
      })
    },
  })

  return {
    baseURL: `${server.url}v1`,
    requests,
    get imageRequests() {
      return imageRequests
    },
    close: () => server.stop(true),
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
