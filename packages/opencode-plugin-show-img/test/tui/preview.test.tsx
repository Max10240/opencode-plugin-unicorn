/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { ImageRenderable, type Renderable, type ScrollBoxRenderable } from "@opentui/core"
import { testRender, useRenderer } from "@opentui/solid"
import type { Context } from "@opencode/plugin/tui/context"
import { createMemo, createSignal, For, Show, type JSX } from "solid-js"
import { setupImagePreview } from "../../src/tui.js"
import type { PreviewImage } from "../../src/preview-rpc.js"
import { rasterFixtures } from "../fixtures.js"

type Read = (input: { sessionID: string; assetID: string }, options: { signal: AbortSignal; location: unknown }) => Promise<PreviewImage>
function tool(assetID: string, status = "completed", metadata: unknown = { imagePreview: { assetID, name: `${assetID}.png` } }) {
  return { type: "tool", id: `call_${assetID}`, name: "show_img", state: { status, metadata } }
}
function assistant(...content: unknown[]) { return { id: "msg_fixture", type: "assistant", content } }
function image(fixture: typeof rasterFixtures[number] = rasterFixtures[0]): PreviewImage {
  return { data: fixture.bytes.toString("base64"), mime: fixture.mime, name: `${fixture.kind}.bin` }
}

async function renderPreview(read: Read, width = 80, height = 24) {
  const [messages, setMessages] = createSignal<Record<string, unknown[]>>({ a: [assistant(tool("first"))], b: [] })
  const [sessionID, setSessionID] = createSignal("a")
  const [enabled, setEnabled] = createSignal(true)
  const [tail, setTail] = createSignal("")
  const [mounted, setMounted] = createSignal(true)
  const [revertID, setRevertID] = createSignal<string>()
  const [dialog, setDialog] = createSignal<() => JSX.Element>()
  let closeDialog: (() => void) | undefined
  let render!: () => JSX.Element
  let scroll!: ScrollBoxRenderable
  const unregister = () => { removed = true; setEnabled(false) }
  let removed = false
  const context = {
    options: {},
    renderer: undefined,
    client: { rpc: () => ({ read }) },
    data: { session: {
      message: { list: (id: string) => messages()[id] ?? [] },
      get: (id: string) => ({ location: { directory: `/server/${id}` }, ...(revertID() ? { revert: { messageID: revertID() } } : {}) }),
    } },
    theme: { text: { base: "#ffffff", muted: "#aaaaaa", feedback: { error: { base: "#ff0000" } } } },
    ui: { slot: (claim: { append: string; render: typeof render }) => {
      expect(claim.append).toBe("app")
      render = claim.render
      return unregister
    }, router: { current: () => ({ type: "session", sessionID: sessionID() }) }, dialog: {
      set() {},
      show(render: () => JSX.Element, onClose?: () => void) { closeDialog?.(); closeDialog = onClose; setDialog(() => render) },
      clear() { const close = closeDialog; closeDialog = undefined; close?.(); setDialog(undefined) },
    } },
  } as unknown as Context
  const cleanup = setupImagePreview(context)
  const app = await testRender(() => {
    ;(context as any).renderer = useRenderer()
    let previous = new Map<string, { id: string; anchor: string }>()
    const rows = createMemo(() => {
      const next = new Map<string, { id: string; anchor: string }>()
      for (const message of messages()[sessionID()] ?? []) {
        const value = message as any
        value.content.forEach((part: any, index: number) => {
          const id = `${sessionID()}:${value.id}:${part.id ?? index}`
          const anchor = index === 0 ? value.id : `session-part:${value.id}:${part.id}`
          next.set(id, previous.get(id) ?? { id, anchor })
        })
      }
      previous = next
      return [...next.values()]
    })
    return <box height="100%">
      <scrollbox ref={(value: ScrollBoxRenderable) => { scroll = value }} flexGrow={1}>
        <Show when={mounted()}><For each={rows()}>{(row) => <box id={row.anchor} flexShrink={0}><text>Tool output</text></box>}</For></Show>
        <text flexShrink={0}>{tail()}</text>
      </scrollbox>
      <text>Composer</text>
      <Show when={enabled()}>{render()}</Show>
      <Show when={dialog()}>{(renderDialog) => <box position="absolute" width="100%" height="100%" backgroundColor="#000000">{renderDialog()()}</box>}</Show>
    </box>
  }, { width, height })
  const waitForPlugin = async (ready: () => boolean) => {
    const deadline = Date.now() + 2000
    while (Date.now() < deadline) {
      await app.flush()
      if (ready()) return
      await Bun.sleep(5)
    }
    throw new Error(`Plugin update did not settle\n${app.captureCharFrame()}`)
  }
  return { ...app, waitForPlugin, context, setMessages, setSessionID, setTail, setMounted, setRevertID, cleanup, scroll: () => scroll, removed: () => removed }
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
    expect(preview.width).toBe(app.scroll().viewport.width - 4)
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
    expect(findImage(app.renderer.root)?.width).toBe(app.scroll().viewport.width - 4)
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
    app.setMessages({ a: [assistant(tool("second"))], b: [] })
    await app.flush()
    expect(calls).toHaveLength(2)
    expect(calls[0].signal.aborted).toBe(true)
    expect(calls[1].location).toEqual({ directory: "/server/a" })
    app.setSessionID("b")
    await app.flush()
    expect(calls[1].signal.aborted).toBe(true)
    expect(app.captureCharFrame()).not.toContain("Image preview:")
    app.setMessages({ b: [assistant(tool("third"))] })
    await app.waitForFrame((frame) => frame.includes("third.png") && frame.includes("Loading image preview"))
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
    app.setMessages({ a: [assistant(tool("recovered"))] })
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

test("previews belong to the transcript, move with scrolling and are clipped outside the viewport", async () => {
  const app = await renderPreview(async () => image())
  try {
    await app.waitForFrame((frame) => frame.includes("96 x 48"))
    const preview = findImage(app.renderer.root)!
    let parent: Renderable | null = preview
    while (parent && parent !== app.scroll()) parent = parent.parent as Renderable | null
    expect(parent).toBe(app.scroll())
    const original = preview.y
    app.setTail("Later transcript line\n".repeat(80))
    await app.flush()
    app.scroll().scrollTo(3)
    await app.flush()
    expect(preview.y).toBe(original - 3)
    app.scroll().scrollTo(30)
    await app.flush()
    expect(app.captureCharFrame()).not.toContain("Image preview: first.png")
    expect(app.captureCharFrame()).toContain("Composer")
    app.scroll().scrollTo(0)
    await app.waitForFrame((frame) => frame.includes("Image preview: first.png") && frame.includes("96 x 48"))
  } finally { app.renderer.destroy() }
})

test("multiple tool images retain their own inline previews instead of replacing the previous one", async () => {
  const calls: string[] = []
  const app = await renderPreview(async ({ assetID }) => { calls.push(assetID); return image() }, 80, 45)
  try {
    await app.waitForFrame((frame) => frame.includes("first.png"))
    app.setMessages({ a: [assistant(tool("first"), tool("second"))] })
    await app.waitForFrame((frame) => frame.includes("first.png") && frame.includes("second.png") && frame.split("96 x 48").length === 3)
    expect(calls).toEqual(["first", "second"])
  } finally { app.renderer.destroy() }
})

test("virtualized rows abort image reads, do not fall back to the composer and remount when history returns", async () => {
  const pending = Promise.withResolvers<PreviewImage>()
  const calls: AbortSignal[] = []
  const app = await renderPreview(async (_input, options) => { calls.push(options.signal); return pending.promise })
  try {
    await app.waitForFrame((frame) => frame.includes("Loading image preview"))
    app.setMounted(false)
    await app.flush()
    expect(calls[0].aborted).toBe(true)
    expect(app.captureCharFrame()).not.toContain("Image preview:")
    app.setMessages({ a: [assistant(tool("second"))] })
    await app.flush()
    expect(calls).toHaveLength(1)
    app.setMounted(true)
    await app.waitForPlugin(() => app.captureCharFrame().includes("second.png"))
    expect(calls).toHaveLength(2)
    expect(calls[1].aborted).toBe(false)
  } finally { app.renderer.destroy(); pending.resolve(image()) }
  expect(calls[1].aborted).toBe(true)
})

test("revert and plugin cleanup remove previews and renderer listeners", async () => {
  const app = await renderPreview(async () => image())
  try {
    await app.waitForFrame((frame) => frame.includes("96 x 48"))
    app.setRevertID("msg_fixture")
    await app.flush()
    expect(app.captureCharFrame()).not.toContain("Image preview:")
    app.setRevertID(undefined)
    await app.waitForFrame((frame) => frame.includes("96 x 48"))
    const listeners = app.renderer.listenerCount("frame")
    const container = app.renderer.root.findDescendantById("show-img-preview:a:msg_fixture:call_first")?.parent
    app.cleanup()
    await app.flush()
    expect(container?.isDestroyed).toBe(true)
    expect(app.renderer.listenerCount("frame")).toBe(listeners - 1)
    expect(app.captureCharFrame()).not.toContain("Image preview:")
  } finally { app.renderer.destroy() }
})

test("distant images release their reads and reload only when scrolled back near the viewport", async () => {
  const pending = Promise.withResolvers<PreviewImage>()
  const signals: AbortSignal[] = []
  const app = await renderPreview(async (_input, options) => { signals.push(options.signal); return pending.promise })
  try {
    await app.waitForFrame((frame) => frame.includes("Loading image preview"))
    app.setTail("Later transcript line\n".repeat(80))
    await app.flush()
    app.scroll().scrollTo(app.scroll().scrollHeight)
    await app.waitForPlugin(() => signals[0].aborted)
    expect(signals).toHaveLength(1)
    app.scroll().scrollTo(0)
    await app.waitForPlugin(() => app.captureCharFrame().includes("Loading image preview"))
    expect(signals).toHaveLength(2)
    expect(signals[1].aborted).toBe(false)
  } finally { app.renderer.destroy(); pending.resolve(image()) }
  expect(signals[1].aborted).toBe(true)
})

test("long filenames do not overlap the next transcript row in narrow terminals", async () => {
  const app = await renderPreview(async () => image(), 40)
  try {
    app.setMessages({ a: [assistant(tool("first", "completed", { imagePreview: { assetID: "first", name: "very-long-name-".repeat(15) + ".png" } }))] })
    await app.waitForFrame((frame) => frame.includes("96 x 48"))
    const block = app.renderer.root.findDescendantById("show-img-preview:a:msg_fixture:call_first")!
    const header = block.getChildren()[0].getChildren()[0]
    expect(header.height).toBe(1)
    const preview = findImage(app.renderer.root)!
    expect(preview.y + preview.height).toBeLessThanOrEqual(block.y + block.height)
  } finally { app.renderer.destroy() }
})

test("unloading or reverting the source closes its enlarged preview without closing a replacement dialog", async () => {
  for (const action of ["disable", "revert", "session", "virtualize", "replace"] as const) {
    const app = await renderPreview(async () => image())
    try {
      await app.waitForFrame((frame) => frame.includes("96 x 48"))
      const preview = findImage(app.renderer.root)!
      await app.mockMouse.click(preview.x + 1, preview.y + 1)
      await app.waitForFrame((frame) => frame.includes("Esc to close"))
      if (action === "replace") app.context.ui.dialog.show(() => <text>Unrelated dialog</text>)
      if (action === "revert") app.setRevertID("msg_fixture")
      else if (action === "session") app.setSessionID("b")
      else if (action === "virtualize") app.setMounted(false)
      else app.cleanup()
      await app.flush()
      expect(app.captureCharFrame()).not.toContain("Esc to close")
      if (action === "replace") expect(app.captureCharFrame()).toContain("Unrelated dialog")
    } finally { app.context.ui.dialog.clear(); app.renderer.destroy() }
  }
})
