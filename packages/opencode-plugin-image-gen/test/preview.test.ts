import { expect, test } from "bun:test"
import type { Context } from "@opencode/plugin/promise/plugin"
import type { ToolContext } from "@opencode/plugin/promise/tool"
import { prepareImagePreview } from "../src/preview.js"

const reference = { assetID: "9c416db5-98c8-445c-bbb4-5807a9c8856d", name: "image-v2.png" }
const tool = { sessionID: "session", id: "call_image_gen", messageID: "message", agent: "build", progress: async () => {} } as unknown as ToolContext
type Entry = Awaited<ReturnType<Context["tool"]["list"]>>[number]
function context(list: () => Promise<Partial<Entry>[]>) {
  return { tool: { list } } as unknown as Pick<Context, "tool">
}

test("calls the optional tool with the saved absolute path and original session context, forwarding only a reference", async () => {
  const calls: unknown[] = []
  const ctx = context(async () => [{ id: "show_img", execute: async (input, current) => {
    calls.push([input, current])
    return { content: "PRIVATE_CONTENT", output: { data: "PRIVATE_OUTPUT" }, metadata: { imagePreview: { ...reference, data: "PRIVATE_BYTES" }, other: "PRIVATE_METADATA" } }
  } }])
  expect(await prepareImagePreview(ctx, tool, "/server/image-v2.png")).toEqual(reference)
  expect(calls).toEqual([[{ abs_file_path: "/server/image-v2.png" }, tool]])
})

test("has no dependency on show-img and discovers current tools on every generation", async () => {
  let available = false
  let calls = 0
  const ctx = context(async () => available ? [{ id: "show_img", execute: async () => { calls++; return { metadata: { imagePreview: reference } } } }] : [])
  expect(await prepareImagePreview(ctx, tool, "/server/image.png")).toBeUndefined()
  available = true
  expect(await prepareImagePreview(ctx, tool, "/server/image.png")).toEqual(reference)
  available = false
  expect(await prepareImagePreview(ctx, tool, "/server/image.png")).toBeUndefined()
  expect(calls).toBe(1)
})

test("list and executor failures do not reject the completed generation", async () => {
  for (const ctx of [
    context(async () => { throw new Error("list unavailable") }),
    context(async () => [{ id: "show_img", execute: async () => { throw new Error("preview failed") } }]),
    { tool: {} } as unknown as Pick<Context, "tool">,
  ]) expect(await prepareImagePreview(ctx, tool, "/server/image.png")).toBeUndefined()
})

test("ignores malformed preview responses rather than forwarding image data", async () => {
  for (const value of [undefined, null, "data:image/png;base64,SECRET", {}, { assetID: 1, name: "image.png" },
    { assetID: "data:image/png;base64,SECRET", name: "image.png" }, { assetID: reference.assetID, name: "" }]) {
    const ctx = context(async () => [{ id: "show_img", execute: async () => ({ content: "SECRET", metadata: { imagePreview: value } }) }])
    expect(await prepareImagePreview(ctx, tool, "/server/image.png")).toBeUndefined()
  }
})
