import { expect, test } from "bun:test"
import type { Renderable } from "@opentui/core"
import { nearViewport, previewAnchors, previewEntries } from "../src/inline.js"

const tool = (id: string, name = "show_img", status = "completed") => ({ type: "tool", id, name, state: { status, metadata: { imagePreview: { assetID: id, name: `${id}.png` } } } })

test("each completed preview keeps its own tool anchor and only the first visible part owns the message boundary", () => {
  const entries = previewEntries("s", [{ id: "m", type: "assistant", content: [{ type: "text", text: "" }, tool("first"), tool("second", "image_gen"), tool("pending", "show_img", "running"), tool("other", "read")] }])
  expect(entries).toHaveLength(2)
  expect(entries[0].anchors).toEqual(["session-part:m:first", "m"])
  expect(entries[1].anchors).toEqual(["session-part:m:second"])
  expect(entries[0].key).not.toBe(entries[1].key)
  expect(previewEntries("s", [{ id: "m", type: "assistant", content: [{ type: "reasoning", text: "thought" }, tool("image")] }])[0].anchors).toEqual(["session-part:m:image"])
})

test("reverted messages, malformed references and non-assistant messages cannot create previews", () => {
  expect(previewEntries("s", [{ id: "m", type: "user", content: [tool("image")] }])).toEqual([])
  expect(previewEntries("s", [{ id: "m", type: "assistant", content: [tool("image")] }], "m")).toEqual([])
  expect(previewEntries("s", [{ id: "m", type: "assistant", content: [{ ...tool("image"), state: { status: "completed", metadata: {} } }] }])).toEqual([])
})

test("only visible transcript anchors are used, never hidden tabs, dialogs or the composer", () => {
  const entries = previewEntries("s", [{ id: "m", type: "assistant", content: [tool("image")] }])
  const node = (id: string | undefined, children: any[] = [], extra = {}) => ({ id, visible: true, isDestroyed: false, height: 1, getChildren: () => children, ...extra })
  const visible = node("m")
  const hidden = node("m", [], { visible: false })
  const root = node("root", [node(undefined), node("composer", [node("m")]), node("scroll", [hidden, visible], { scrollTo() {}, viewport: {} })])
  expect(previewAnchors(root as unknown as Renderable, entries).get("m")).toBe(visible as any)
  visible.isDestroyed = true
  expect(previewAnchors(root as unknown as Renderable, entries).size).toBe(0)
})

test("decoding is limited to the viewport and one adjacent screen", () => {
  const scroll = { parent: null, scrollTo() {}, viewport: { y: 10, height: 20 } }
  const target = { parent: scroll, y: 40, height: 10 }
  expect(nearViewport(target as unknown as Renderable)).toBe(true)
  target.y = 80
  expect(nearViewport(target as unknown as Renderable)).toBe(false)
  target.y = -40
  expect(nearViewport(target as unknown as Renderable)).toBe(false)
})

test("a zero-size transcript in a hidden tab cannot shadow the active message anchor", () => {
  const entries = previewEntries("s", [{ id: "m", type: "assistant", content: [tool("image")] }])
  const anchor = () => ({ id: "m", visible: true, isDestroyed: false, height: 1, getChildren: () => [] })
  const active = anchor()
  const hidden = anchor()
  const scroll = (node: ReturnType<typeof anchor>, height: number) => ({ visible: true, isDestroyed: false, height, viewport: { width: 80, height }, scrollTo() {}, getChildren: () => [node] })
  const root = { visible: true, isDestroyed: false, getChildren: () => [scroll(active, 20), scroll(hidden, 0)] }
  expect(previewAnchors(root as unknown as Renderable, entries).get("m")).toBe(active as any)
})
