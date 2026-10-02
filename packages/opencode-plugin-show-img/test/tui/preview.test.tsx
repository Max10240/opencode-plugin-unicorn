/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { ImageRenderable, type Renderable } from "@opentui/core"
import { testRender } from "@opentui/solid"
import type { Context } from "@opencode/plugin/tui/context"
import { createSignal, type JSX } from "solid-js"
import { setupImagePreview } from "../../src/tui.js"
import type { PreviewImage } from "../../src/preview-rpc.js"
import { rasterFixtures } from "../fixtures.js"

type Read = (input: { sessionID: string; assetID: string }, options: { signal: AbortSignal; location: unknown }) => Promise<PreviewImage>
function tool(assetID: string, status = "completed", metadata: unknown = { imagePreview: { assetID, name: `${assetID}.png` } }) {
  return { type: "tool", name: "show_img", state: { status, metadata } }
}
function assistant(...content: unknown[]) { return { type: "assistant", content } }
function image(fixture: typeof rasterFixtures[number] = rasterFixtures[0]): PreviewImage {
  return { data: fixture.bytes.toString("base64"), mime: fixture.mime, name: `${fixture.kind}.bin` }
}

async function renderPreview(read: Read, width = 80, height = 24) {
  const [messages, setMessages] = createSignal<Record<string, unknown[]>>({ a: [assistant(tool("first"))], b: [] })
  const [sessionID, setSessionID] = createSignal("a")
  let render!: (input: { sessionID: string }) => JSX.Element
  const unregister = () => { removed = true }
  let removed = false
  const context = {
    client: { rpc: () => ({ read }) },
    data: { session: {
      message: { list: (id: string) => messages()[id] ?? [] },
      get: (id: string) => ({ location: { directory: `/server/${id}` } }),
    } },
    theme: { text: { base: "#ffffff", muted: "#aaaaaa", feedback: { error: { base: "#ff0000" } } } },
    ui: { slot: (claim: { append: string; render: typeof render }) => {
      expect(claim.append).toBe("session.composer.top")
      render = claim.render
      return unregister
    } },
  } as unknown as Context
  const cleanup = setupImagePreview(context)
  const app = await testRender(() => render({ get sessionID() { return sessionID() } }), { width, height })
  return { ...app, setMessages, setSessionID, cleanup, removed: () => removed }
}

function findImage(root: Renderable): ImageRenderable | undefined {
  if (root instanceof ImageRenderable) return root
  return root.getChildren().map(findImage).find(Boolean)
}

test.each([...rasterFixtures])("renders actual $kind pixels, not just a success label", async (fixture) => {
  const app = await renderPreview(async () => image(fixture))
  try {
    await app.waitForFrame((frame) => frame.includes(`${fixture.width} x ${fixture.height}`))
    const preview = findImage(app.renderer.root)!
    expect(preview).toBeInstanceOf(ImageRenderable)
    expect(preview.image?.width).toBe(fixture.width)
    expect(preview.image?.height).toBe(fixture.height)
    expect(preview.width).toBe(76)
    expect(preview.height).toBe(6)
    expect(preview.fit).toBe("fit")
    expect(preview.protocol).toBe("auto")
  } finally { app.renderer.destroy(); app.cleanup() }
  expect(app.removed()).toBe(true)
})

test.each([{ width: 40, height: 16 }, { width: 120, height: 40 }])("fits image pixels in a $width-column terminal", async ({ width, height }) => {
  const app = await renderPreview(async () => image(), width, height)
  try {
    await app.waitForFrame((frame) => frame.includes("96 x 48"))
    expect(findImage(app.renderer.root)?.width).toBe(width - 4)
    expect(findImage(app.renderer.root)?.height).toBe(6)
    expect(app.captureCharFrame()).toContain("Click to enlarge")
  } finally { app.renderer.destroy() }
})

test("shows loading and ignores pending, failed, malformed and unrelated tools", async () => {
  const pending = Promise.withResolvers<PreviewImage>()
  const calls: string[] = []
  const app = await renderPreview(async ({ assetID }) => { calls.push(assetID); return pending.promise })
  try {
    await app.waitForFrame((frame) => frame.includes("Loading image preview"))
    app.setMessages({ a: [assistant(tool("first"), tool("pending", "running"), tool("failed", "error"), tool("malformed", "completed", {}),
      { ...tool("other"), name: "read" })] })
    await app.flush()
    expect(calls).toEqual(["first"])
    pending.resolve(image())
    await app.waitForFrame((frame) => frame.includes("96 x 48"))
    expect(app.captureCharFrame()).toContain("first.png")
    app.setMessages({ a: [assistant(tool("first"))] })
    await app.flush()
    expect(calls).toEqual(["first"])
  } finally { pending.resolve(image()); app.renderer.destroy() }
})

test("renders image_gen preview metadata through the same UI-only RPC", async () => {
  const ids: string[] = []
  const app = await renderPreview(async ({ assetID }) => { ids.push(assetID); return image() })
  try {
    await app.waitForFrame((frame) => frame.includes("96 x 48"))
    app.setMessages({ a: [assistant(tool("first"), { ...tool("generated"), name: "image_gen" })] })
    await app.waitForFrame((frame) => frame.includes("generated.png") && frame.includes("96 x 48"))
    expect(ids).toEqual(["first", "generated"])
    expect(findImage(app.renderer.root)?.image?.width).toBe(96)
  } finally { app.renderer.destroy() }
})

test("aborts stale reads on image and session changes and on unmount", async () => {
  const pending = Promise.withResolvers<PreviewImage>()
  const calls: Array<{ sessionID: string; assetID: string; signal: AbortSignal; location: unknown }> = []
  const app = await renderPreview(async (input, options) => { calls.push({ ...input, ...options }); return pending.promise })
  try {
    await app.waitForFrame((frame) => frame.includes("Loading image preview"))
    expect(calls[0].signal.aborted).toBe(false)
    app.setMessages({ a: [assistant(tool("first"), tool("second"))], b: [] })
    await app.flush()
    expect(calls).toHaveLength(2)
    expect(calls[0].signal.aborted).toBe(true)
    expect(calls[1].location).toEqual({ directory: "/server/a" })
    app.setSessionID("b")
    await app.flush()
    expect(calls[1].signal.aborted).toBe(true)
    expect(app.captureCharFrame()).not.toContain("Image preview:")
    app.setMessages({ b: [assistant(tool("third"))] })
    await app.flush()
    expect(calls[2].sessionID).toBe("b")
    expect(calls[2].location).toEqual({ directory: "/server/b" })
    expect(calls[2].signal.aborted).toBe(false)
  } finally { app.renderer.destroy(); pending.resolve(image()) }
  expect(calls[2].signal.aborted).toBe(true)
})

test.each(["fetch", "decode"])("recovers from a %s failure when a new image arrives", async (failure) => {
  const app = await renderPreview(async ({ assetID }) => {
    if (assetID !== "first") return image()
    if (failure === "fetch") throw new Error("PRIVATE_RPC_ERROR")
    return { ...image(), data: Buffer.from([1, 2, 3]).toString("base64") }
  })
  try {
    await app.waitForFrame((frame) => frame.includes(failure === "fetch" ? "Image preview unavailable" : "Could not decode image"))
    expect(app.captureCharFrame()).not.toContain("PRIVATE_RPC_ERROR")
    expect(findImage(app.renderer.root)).toBeUndefined()
    app.setMessages({ a: [assistant(tool("first"), tool("recovered"))] })
    await app.waitForFrame((frame) => frame.includes("96 x 48"))
    expect(app.captureCharFrame()).not.toContain("unavailable")
    expect(app.captureCharFrame()).not.toContain("Could not")
    expect(findImage(app.renderer.root)?.image?.width).toBe(96)
  } finally { app.renderer.destroy() }
})

test("a late response from a cancelled read cannot replace the current session image", async () => {
  const first = Promise.withResolvers<PreviewImage>()
  const second = Promise.withResolvers<PreviewImage>()
  const app = await renderPreview(async ({ sessionID }) => sessionID === "a" ? first.promise : second.promise)
  try {
    await app.waitForFrame((frame) => frame.includes("Loading image preview"))
    app.setMessages({ a: [assistant(tool("first"))], b: [assistant(tool("second"))] })
    app.setSessionID("b")
    await app.flush()
    second.resolve(image(rasterFixtures[1]))
    await app.waitForFrame((frame) => frame.includes("128 x 128"))
    // Simulate a transport that delivers a response even after AbortSignal cancellation.
    first.resolve(image())
    await app.flush()
    expect(findImage(app.renderer.root)?.image?.width).toBe(128)
    expect(app.captureCharFrame()).toContain("second.png")
    expect(app.captureCharFrame()).not.toContain("96 x 48")
  } finally { first.resolve(image()); second.resolve(image()); app.renderer.destroy() }
})
