import { expect } from "bun:test"
import { mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises"
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

  await checkTUI(e2e, sessionID, serverOnly, file)
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

async function checkTUI(e2e: E2E, sessionID: string, serverOnly: string, file: string) {
  if (Bun.spawnSync(["tmux", "-V"]).exitCode !== 0) throw new Error("tmux is required for image-preview E2E")
  const root = path.join(e2e.root, "client")
  const configDirectory = path.join(root, "config")
  await mkdir(configDirectory, { recursive: true })
  const config = await e2e.config()
  const plugin = (config.plugins.find((entry: { package: string }) => entry.package.includes("opencode-plugin-show-img")) ?? config.plugins[0]) as { package: string }
  const pluginRoot = path.basename(plugin.package) === "dist" ? path.dirname(plugin.package) : plugin.package
  const combined = path.basename(pluginRoot) === "opencode-plugin-unicorn"
  const configure = (showImg: boolean) => writeFile(path.join(configDirectory, "cli.json"), JSON.stringify({
    session: { image_preview: false }, prompt: { image_preview: false },
    keybinds: { "session.list": "f8", "session.tab.select.1": "f9", "session.first": "f6", "session.last": "f7" },
    plugins: [{ package: plugin.package, options: combined
      ? { features: { promptSearch: false }, showImg: { features: { showImg } } }
      : { features: { promptSearch: false, showImg } } }],
  }))
  await configure(true)
  const sandbox = process.platform === "darwin"
    ? ["sandbox-exec", "-p", `(version 1)(allow default)(deny file-read* (subpath ${JSON.stringify(serverOnly)}))`]
    : []
  if (sandbox.length > 0) {
    const denied = Bun.spawnSync([...sandbox, "node", "-e", "require('node:fs').readFileSync(process.argv[1])", file], { stdout: "pipe", stderr: "pipe" })
    expect(denied.exitCode).not.toBe(0)
    expect(denied.stderr.toString()).toMatch(/EPERM|EACCES/)
  }
  const environment = {
    PATH: process.env.PATH ?? "/usr/bin:/bin:/opt/homebrew/bin", TERM: "xterm-256color",
    HOME: root, OPENCODE_CONFIG_DIR: configDirectory, OPENCODE_CONFIG_PROJECT_DISABLE: "1",
    OPENCODE_PASSWORD: password, OPENCODE_DISABLE_MODELS_FETCH: "1",
    OPENCODE_LOG_LEVEL: "DEBUG",
    XDG_CONFIG_HOME: path.join(root, "xdg-config"), XDG_DATA_HOME: path.join(root, "xdg-data"),
    XDG_CACHE_HOME: path.join(root, "xdg-cache"), XDG_STATE_HOME: path.join(root, "xdg-state"),
  }
  const command = [
    `cd ${quote(root)} && env -i`,
    ...Object.entries(environment).map(([key, value]) => `${key}=${quote(value)}`),
    [...sandbox, process.env.OPENCODE_BIN ?? "opencode", "--server", e2e.baseURL, "--session", sessionID].map(quote).join(" "),
  ].join(" ")
  const socket = `show-img-${process.pid}-${crypto.randomUUID()}`
  const tmux = (args: string[]) => {
    const result = Bun.spawnSync(["tmux", "-L", socket, "-f", "/dev/null", ...args], { stdout: "pipe", stderr: "pipe" })
    if (result.exitCode !== 0) throw new Error(`tmux failed: ${result.stderr}`)
    return result.stdout.toString()
  }
  const pane = () => tmux(["capture-pane", "-pt", "preview"])
  try {
    // Attach after tool completion: persisted IDs must work without a live-only preview event.
    tmux(["new-session", "-d", "-s", "preview", "-x", "100", "-y", "36", command])
    await waitFor(async () => pane().includes(`Image preview: ${path.basename(file)}`), "Image preview did not appear")
    await waitFor(async () => pane().includes("1 x 1") && pane().includes("Click to enlarge"), "RPC image did not decode in the TUI")
    expect(pane()).not.toContain("Image preview unavailable")
    const lines = pane().split("\n")
    const row = lines.findIndex((line) => line.includes("Click to enlarge")) + 1
    const column = lines[row - 1].indexOf("Click to enlarge") + 1
    tmux(["send-keys", "-t", "preview", "-l", `\x1b[<0;${column};${row}M\x1b[<0;${column};${row}m`])
    await waitFor(async () => pane().includes("Esc to close"), "Click-to-enlarge dialog did not open")
    tmux(["resize-window", "-t", "preview", "-x", "80", "-y", "28"])
    await waitFor(async () => pane().includes("Esc to close") && pane().includes(path.basename(file)), "Image dialog did not adapt to a narrow terminal")
    tmux(["send-keys", "-t", "preview", "Escape"])
    await waitFor(async () => !pane().includes("Esc to close"), "Image dialog did not close")
    tmux(["resize-window", "-t", "preview", "-x", "100", "-y", "36"])

    e2e.proxy.mock.prependFixture({ match: { userMessage: "E2E_SCROLL_IMAGE", hasToolResult: false }, response: { content: "scroll transcript line\n".repeat(60) + "IMAGE_SCROLL_END" } })
    await prompt(e2e, sessionID, "E2E_SCROLL_IMAGE")
    await waitFor(async () => pane().includes("IMAGE_SCROLL_END") && !pane().includes("Image preview:"), "Image stayed fixed at the bottom instead of scrolling with its tool output")
    tmux(["send-keys", "-t", "preview", "F6"])
    await waitFor(async () => pane().includes(`Image preview: ${path.basename(file)}`) && pane().includes("Click to enlarge"), "Scrolling back did not restore the original inline preview")
    tmux(["send-keys", "-t", "preview", "F7"])
    await waitFor(async () => pane().includes("IMAGE_SCROLL_END") && !pane().includes("Image preview:"), "Last-message navigation left the old preview pinned")

    const liveFile = path.join(serverOnly, "live-image.png")
    await writeFile(liveFile, imageBytes)
    e2e.proxy.mock.prependFixture({
      match: { userMessage: "E2E_SHOW_IMG_LIVE", toolName: "show_img", hasToolResult: false },
      response: { toolCalls: [{ id: "call_show_img_live", name: "show_img", arguments: JSON.stringify({ abs_file_path: liveFile }) }] },
    })
    e2e.proxy.mock.prependFixture({ match: { toolCallId: "call_show_img_live" }, response: { content: "SHOW_IMG_LIVE_DONE" } })
    await prompt(e2e, sessionID, "E2E_SHOW_IMG_LIVE")
    await waitFor(async () => pane().includes("Image preview: live-image.png") && pane().includes("1 x 1"), "Live tool completion did not update the preview")
    const liveLines = pane().split("\n")
    const liveHeader = liveLines.findIndex((line) => line.includes("Image preview: live-image.png"))
    const liveRow = liveLines.findIndex((line, index) => index > liveHeader && line.includes("Click to enlarge")) + 1
    const liveColumn = liveLines[liveRow - 1].indexOf("Click to enlarge") + 1
    tmux(["send-keys", "-t", "preview", "-l", `\x1b[<0;${liveColumn};${liveRow}M\x1b[<0;${liveColumn};${liveRow}m`])
    await waitFor(async () => pane().includes("Esc to close"), "Live image did not enlarge before disabling the plugin")
    await configure(false)
    await waitFor(async () => !pane().includes("Image preview:") && !pane().includes("Esc to close"), "Client showImg feature left an inline preview or enlarged dialog after disabling")
    await configure(true)
    await waitFor(async () => pane().includes("Image preview: live-image.png") && pane().includes("1 x 1"), "Client plugin reload did not restore the persisted preview reference")

    // A valid signature with an invalid payload must fail in the renderer, then recover.
    const malformed = path.join(serverOnly, "malformed.png")
    await writeFile(malformed, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    expect((await showImage(e2e, sessionID, malformed)).state.status).toBe("completed")
    await waitFor(async () => pane().includes("Could not decode image"), "Malformed image did not show a decode error")
    for (const fixture of rasterFixtures) {
      const file = path.join(serverOnly, `format-${fixture.kind}.bin`)
      await writeFile(file, fixture.bytes)
      expect((await showImage(e2e, sessionID, file)).state.status).toBe("completed")
      await waitFor(async () => pane().includes(`Image preview: format-${fixture.kind}.bin`) && pane().includes(`${fixture.width} x ${fixture.height}`), `${fixture.kind} did not decode in the real TUI`)
      expect(pane().slice(pane().lastIndexOf(`Image preview: format-${fixture.kind}.bin`))).not.toContain("Could not decode image")
    }

    const deleted = path.join(serverOnly, "deleted.png")
    await writeFile(deleted, imageBytes)
    await showImage(e2e, sessionID, deleted)
    await waitFor(async () => pane().includes("Image preview: deleted.png") && pane().includes("1 x 1"), "Preview before deletion did not appear")
    await rm(deleted)
    await configure(false)
    await waitFor(async () => !pane().includes("Image preview:"), "Preview did not unmount before the missing-file read")
    await configure(true)
    await waitFor(async () => pane().includes("Image preview unavailable"), "Deleted image did not show an RPC read error")
    await showImage(e2e, sessionID, liveFile)
    await waitFor(async () => pane().includes("Image preview: live-image.png") && pane().includes("1 x 1"), "Preview did not recover from a missing-file read")

    const other = await createSession(e2e, "Show-Img-Other")
    const otherFile = path.join(serverOnly, "other-session.png")
    await writeFile(otherFile, rasterFixtures[0].bytes)
    await showImage(e2e, other, otherFile)
    const switchTo = async (title: string, label: string) => {
      tmux(["send-keys", "-t", "preview", "F8"])
      await waitFor(async () => pane().includes("Sessions"), "Session picker did not open")
      tmux(["send-keys", "-t", "preview", "-l", title])
      await waitFor(async () => pane().includes(title), "Session picker did not find the target")
      tmux(["send-keys", "-t", "preview", "Enter"])
      await waitFor(async () => pane().includes(label) && pane().includes("Click to enlarge"), "Switching sessions did not restore the correct preview")
    }
    await switchTo("Show-Img-Other", "Image preview: other-session.png")
    expect(pane()).not.toContain("Image preview: live-image.png")
    tmux(["send-keys", "-t", "preview", "F9"])
    await waitFor(async () => pane().includes("Image preview: live-image.png") && pane().includes("1 x 1"), "Returning to the original tab did not restore its preview")
    expect(pane()).not.toContain("Image preview: other-session.png")

    const requestsBeforeRestart = e2e.proxy.mock.getRequests().length
    tmux(["kill-window", "-t", "preview"])
    await e2e.restart()
    tmux(["new-session", "-d", "-s", "preview", "-x", "100", "-y", "36", command])
    await waitFor(async () => pane().includes("Image preview: live-image.png") && pane().includes("1 x 1"), "Real server/client restart did not restore the persisted preview")
    expect(e2e.proxy.mock.getRequests().length).toBe(requestsBeforeRestart)
  } catch (error) {
    const log = await readFile(path.join(root, "xdg-data/opencode/log/opencode.log"), "utf8").catch(() => "")
    let screen = "TUI pane is unavailable"
    try { screen = pane() } catch {}
    throw new Error(`${error instanceof Error ? error.message : String(error)}\n${screen}\n${log.split("\n").filter((line) => /plugin operation failed|crashed|Cannot find/.test(line)).slice(-12).join("\n")}`)
  } finally {
    Bun.spawnSync(["tmux", "-L", socket, "kill-server"], { stdout: "pipe", stderr: "pipe" })
  }
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

export async function waitFor(check: () => Promise<boolean>, message: string) {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    if (await check()) return
    await Bun.sleep(100)
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

export async function checkGeneratedImagePreview(e2e: E2E, enabled: boolean, tui = false, expectedModel = "gpt-image-2.5-sunburst") {
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
  if (enabled && tui) {
    await checkTUI(e2e, second.sessionID, await realpath(e2e.workspace), paths[1])
    await prompt(e2e, second.sessionID, "E2E_AFTER_GENERATED_PREVIEW")
  }
  const bodies = JSON.stringify(e2e.proxy.mock.getRequests().map((entry) => entry.body))
  expect(bodies).not.toContain(PNG_BASE64)
  expect(bodies).not.toContain("data:image/")
  expect(bodies).not.toContain('"type":"image_url"')
}
