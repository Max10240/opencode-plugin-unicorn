import { expect } from "bun:test"
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises"
import path from "node:path"
import { crc32 } from "node:zlib"
import type { OpenCodeE2E } from "../../opencode-plugin-unicorn/test/e2e-utils.js"
import { rasterFixtures } from "./fixtures.js"

export type E2E = OpenCodeE2E
const PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="
const PRIVATE_MARKER = "PRIVATE_IMAGE_BYTES_NOT_FOR_MODEL_6b3f"
const png = Buffer.from(PNG_BASE64, "base64")
const comment = Buffer.from(`Comment\0${PRIVATE_MARKER}`)
const chunk = Buffer.alloc(comment.length + 12)
chunk.writeUInt32BE(comment.length, 0)
chunk.write("tEXt", 4)
comment.copy(chunk, 8)
chunk.writeUInt32BE(crc32(chunk.subarray(4, chunk.length - 4)), chunk.length - 4)
const imageBytes = Buffer.concat([png.subarray(0, -12), chunk, png.subarray(-12)])
const password = "opencode-plugin-unicorn-e2e"

export async function checkShowImg(e2e: E2E, enabled = true) {
  const config = await e2e.config()
  // A vision-capable model prevents the core's unsupported-media filter from masking a leak.
  config.providers.openai.models["gpt-5.6-luna"].capabilities = { tools: true, input: ["text", "image"], output: ["text"] }
  await writeFile(e2e.configPath, `${JSON.stringify(config)}\n`)
  await waitFor(async () => (await e2e.model().catch(() => undefined))?.capabilities.input.includes("image") === true, "Vision model config did not reload")
  const serverOnlyDirectory = path.join(e2e.root, "server-only")
  await mkdir(serverOnlyDirectory, { recursive: true })
  const serverOnly = await realpath(serverOnlyDirectory)
  const file = path.join(serverOnly, "private-image.png")
  await writeFile(file, imageBytes)

  e2e.proxy.mock.prependFixture({
    match: { userMessage: "E2E_SHOW_IMG", toolName: "show_img", hasToolResult: false },
    response: { toolCalls: [{ id: "call_show_img", name: "show_img", arguments: JSON.stringify({ abs_file_path: file }) }] },
  })
  e2e.proxy.mock.prependFixture({ match: { toolCallId: "call_show_img" }, response: { content: "SHOW_IMG_DONE" } })
  const created = await api<{ data: { id: string } }>(e2e, "/api/session", {
    title: "Show-Img-E2E",
    agent: "compaction-e2e",
    model: { providerID: "openai", id: "gpt-5.6-luna" },
    location: { directory: e2e.workspace },
  })
  const sessionID = created.data.id
  await prompt(e2e, sessionID, "E2E_SHOW_IMG")
  const requests = e2e.proxy.requests
  if (enabled && !requests.some((request) => request.tools.includes("show_img"))) {
    const plugins = await api(e2e, `/api/plugin?${new URLSearchParams({ directory: e2e.workspace })}`)
    const log = await readFile(path.join(e2e.root, "xdg-data/opencode/log/opencode.log"), "utf8").catch(() => "")
    throw new Error(`show_img was not advertised: ${JSON.stringify(plugins)}\n${JSON.stringify(requests)}\n${log.split("\n").filter((line) => /plugin|rpc/.test(line)).slice(-15).join("\n")}`)
  }
  expect(requests.some((request) => request.tools.includes("show_img"))).toBe(enabled)
  if (!enabled) {
    const rpc = await fetch(`${e2e.baseURL}${previewEndpoint(e2e)}`, {
      method: "POST", headers: headers(), body: JSON.stringify({ input: { sessionID, assetID: "disabled" } }),
    })
    expect(rpc.ok).toBe(false)
    return
  }

  const exported = await api<{ data: { messages: Array<Record<string, any>> } }>(e2e, `/api/experimental/session/${sessionID}/export`)
  const tool = exported.data.messages.flatMap((message) => message.content ?? []).find((part) => part.type === "tool" && part.name === "show_img")
  expect(tool?.state.status).toBe("completed")
  expect(tool.state.input).toEqual({ abs_file_path: file })
  expect(tool.state.content.every((item: { type: string }) => item.type === "text")).toBe(true)
  const reference = tool.state.metadata.imagePreview as { assetID: string; name: string }
  expect(Object.keys(reference).sort()).toEqual(["assetID", "name"])
  expect(reference.assetID).toMatch(/^[0-9a-f-]{36}$/)
  const rpcURL = `/api/rpc/max10240.show-img/read?${new URLSearchParams({ directory: e2e.workspace })}`
  const rpc = await api<{ output: { mime: string; data: string; name: string } }>(e2e, rpcURL, {
    input: { sessionID, assetID: reference.assetID },
  })
  expect(Buffer.from(rpc.output.data, "base64")).toEqual(imageBytes)
  expect(rpc.output.mime).toBe("image/png")
  for (const input of [{ sessionID: "other-session", assetID: reference.assetID }, { sessionID, assetID: "unknown" }]) {
    const invalid = await fetch(`${e2e.baseURL}${rpcURL}`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ input }),
    })
    expect(invalid.ok).toBe(false)
    expect(await invalid.text()).not.toContain(PRIVATE_MARKER)
  }
  const unauthenticated = await fetch(`${e2e.baseURL}${rpcURL}`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ input: { sessionID, assetID: reference.assetID } }),
  })
  expect(unauthenticated.status).toBe(401)

  // Exercise another request after the UI fetched and displayed the image.
  await prompt(e2e, sessionID, "E2E_AFTER_IMAGE_PREVIEW")
  const after = await api<{ data: { messages: Array<Record<string, any>> } }>(e2e, `/api/experimental/session/${sessionID}/export`)
  const modelBodies = JSON.stringify(e2e.proxy.mock.getRequests().map((entry) => entry.body))
  const history = JSON.stringify(after.data.messages)
  for (const value of [modelBodies, history]) {
    expect(value).not.toContain(PNG_BASE64)
    expect(value).not.toContain(imageBytes.toString("base64"))
    expect(value).not.toContain(PRIVATE_MARKER)
    expect(value).not.toContain("data:image/")
    expect(value).not.toContain('"type":"image_url"')
    for (const fixture of rasterFixtures) expect(value).not.toContain(fixture.bytes.toString("base64"))
  }
  expect(after.data.messages.flatMap((message) => message.content ?? []).filter((part) => part.type === "tool").every((part) => part.name !== "read")).toBe(true)
  expect(e2e.proxy.requests.some((request) => request.messages.some((message) => JSON.stringify(message).includes("Image preview prepared")))).toBe(true)
}

export async function api<T>(e2e: E2E, endpoint: string, body?: unknown): Promise<T> {
  const response = await fetch(`${e2e.baseURL}${endpoint}`, {
    method: body === undefined ? "GET" : "POST", headers: headers(),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(30_000),
  })
  const text = await response.text()
  if (!response.ok) throw new Error(`API ${endpoint} failed (${response.status}): ${text}`)
  return text ? JSON.parse(text) as T : undefined as T
}

export async function prompt(e2e: E2E, sessionID: string, text: string) {
  await api(e2e, `/api/session/${sessionID}/prompt`, { text, delivery: "queue" })
  await api(e2e, `/api/experimental/session/${sessionID}/wait`, {})
}

export function headers() {
  return { authorization: `Basic ${btoa(`opencode:${password}`)}`, "content-type": "application/json" }
}

export async function waitFor(check: () => Promise<boolean>, message: string, timeout = 30_000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (await check()) return
    await Bun.sleep(25)
  }
  throw new Error(message)
}

function quote(value: string) { return `'${value.replaceAll("'", "'\\''")}'` }

export async function createSession(e2e: E2E, title = "Show-Img-E2E") {
  const created = await api<{ data: { id: string } }>(e2e, "/api/session", {
    title, agent: "compaction-e2e",
    model: { providerID: "openai", id: "gpt-5.6-luna" }, location: { directory: e2e.workspace },
  })
  return created.data.id
}

export async function showImage(e2e: E2E, sessionID: string, file: string) {
  const id = `call_${crypto.randomUUID()}`
  const text = `E2E_SHOW_${id}`
  e2e.proxy.mock.prependFixture({
    match: { userMessage: text, toolName: "show_img", hasToolResult: false },
    response: { toolCalls: [{ id, name: "show_img", arguments: JSON.stringify({ abs_file_path: file }) }] },
  })
  e2e.proxy.mock.prependFixture({ match: { toolCallId: id }, response: { content: "SHOW_IMG_DONE" } })
  await prompt(e2e, sessionID, text)
  const exported = await api<{ data: { messages: Array<Record<string, any>> } }>(e2e, `/api/experimental/session/${sessionID}/export`)
  const parts = exported.data.messages.flatMap((message) => message.content ?? []).filter((part) => part.type === "tool" && part.id === id)
  expect(parts).toHaveLength(1)
  return parts[0] as Record<string, any>
}

export function previewEndpoint(e2e: E2E) {
  return `/api/rpc/max10240.show-img/read?${new URLSearchParams({ directory: e2e.workspace })}`
}

export async function checkGeneratedImagePreview(e2e: E2E, enabled: boolean, expectedModel = "gpt-image-2.5-sunburst") {
  const generationCount = e2e.proxy.imageRequests
  const editCount = e2e.proxy.imageEditRequests
  const first = await e2e.runImagePrompt()
  const second = await e2e.runImagePrompt()
  await writeFile(path.join(e2e.workspace, "e2e-reference.png"), png)
  const edited = await e2e.runImagePrompt("edit")
  const paths: string[] = []
  for (const result of [first, second, edited]) {
    const parts = result.messages.flatMap((message) => message.content ?? []).filter((part) => part.type === "tool")
    // The preview is invoked by image-gen, not left for an extra model round trip to show_img.
    expect(parts.every((part) => part.name === "image_gen")).toBe(true)
    const generated = parts.find((part) => part.name === "image_gen")
    expect(generated?.state.status).toBe("completed")
    const metadata = generated.state.metadata
    expect(metadata.modelID).toBe(expectedModel)
    expect(path.isAbsolute(metadata.out)).toBe(true)
    expect(await readFile(metadata.out)).toEqual(png)
    paths.push(metadata.out)
    if (enabled) {
      expect(metadata.imagePreview).toEqual({ assetID: expect.any(String), name: path.basename(metadata.out) })
      const response = await api<{ output: { data: string; mime: string } }>(e2e, previewEndpoint(e2e), {
        input: { sessionID: result.sessionID, assetID: metadata.imagePreview.assetID },
      })
      expect(response.output.mime).toBe("image/png")
      expect(Buffer.from(response.output.data, "base64")).toEqual(png)
    } else expect(metadata.imagePreview).toBeUndefined()
    expect(JSON.stringify(result.messages)).not.toContain(PNG_BASE64)
    expect(JSON.stringify(generated.state.content)).not.toContain("Preview failed")
  }
  expect(paths[1]).not.toBe(paths[0])
  expect(paths[1]).toMatch(/-v\d+\.png$/)
  expect(e2e.proxy.imageRequests - generationCount).toBe(2)
  expect(e2e.proxy.imageEditRequests - editCount).toBe(1)
  const imageRequests = e2e.proxy.mock.getRequests().filter((request) => /\/images\/(?:generations|edits)$/.test(request.path))
  for (const request of imageRequests.slice(-3)) {
    const body = request.body as Record<string, unknown>
    expect(body.model).toBe(expectedModel)
  }
  const bodies = JSON.stringify(e2e.proxy.mock.getRequests().map((entry) => entry.body))
  expect(bodies).not.toContain(PNG_BASE64)
  expect(bodies).not.toContain("data:image/")
  expect(bodies).not.toContain('"type":"image_url"')
}
