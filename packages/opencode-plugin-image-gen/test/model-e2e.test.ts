import { expect, setDefaultTimeout, test } from "bun:test"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { createOpenCodeE2E } from "../../opencode-plugin-unicorn/test/e2e-utils.js"
import { api, createSession, prompt } from "../../opencode-plugin-show-img/test/e2e-utils.js"

setDefaultTimeout(120_000)

for (const mode of ["standalone", "unicorn"] as const) {
  test(`${mode}: plugin config and tool arguments select image-only models without changing the chat model`, async () => {
    const e2e = await createOpenCodeE2E({
      plugin: mode === "standalone" ? "image-gen" : "unicorn",
      pluginPackage: path.resolve(import.meta.dir, mode === "standalone" ? "../dist" : "../../opencode-plugin-unicorn/dist"),
      pluginOptions: {
        ...(mode === "standalone" ? { model: "openai/gpt-image-2.5-flare" } : { imageGen: { model: "openai/gpt-image-2.5-flare" }, model: "invalid/flat-model-must-not-leak" }),
        features: { recommendedOpencodeConfig: false, showImg: false, promptSearch: false },
      },
    })
    try {
      const sessionID = await createSession(e2e)
      for (const [index, model, quality] of [
        [0, undefined, "xhigh"],
        [1, "openai/gpt-image-2.5-sunburst", "max"],
        [2, "openai/gpt-image-2.5-sunburst-2026-09-08", "high"],
        [3, null, null],
        [4, undefined, "high"],
      ] as const) {
        const id = `call_image_model_${index}`
        const marker = `E2E_IMAGE_MODEL_${index}`
        const out = `model-${index}.png`
        const input = { prompt: "E2E image", out, quality, ...(model ? { model } : model === null ? { model: null, size: null, images: null } : {}), ...(index === 4 ? { size: null } : {}) }
        e2e.proxy.mock.prependFixture({
          match: { userMessage: marker, toolName: "image_gen", hasToolResult: false },
          response: { toolCalls: [{ id, name: "image_gen", arguments: JSON.stringify(input) }] },
        })
        e2e.proxy.mock.prependFixture({ match: { toolCallId: id }, response: { content: "MODEL_IMAGE_DONE" } })
        await prompt(e2e, sessionID, marker)
        const expected = model?.split("/")[1] ?? "gpt-image-2.5-flare"
        const imageRequests = e2e.proxy.mock.getRequests().filter((request) => request.path.endsWith("/images/generations"))
        expect(imageRequests).toHaveLength(index + 1)
        // AIMock normalizes image bodies and omits quality; wire-format tests check that field separately.
        expect(imageRequests.at(-1)?.body).toMatchObject({ model: expected })
        if (index >= 3) for (const field of ["model", "quality", "size", "images"]) expect((imageRequests.at(-1)?.body as Record<string, unknown>)[field]).not.toBeNull()
        const exported = await api<{ data: { messages: Array<Record<string, any>> } }>(e2e, `/api/experimental/session/${sessionID}/export`)
        const part = exported.data.messages.flatMap((message) => message.content ?? []).find((part) => part.type === "tool" && part.id === id)
        expect(part.state.status).toBe("completed")
        expect(part.state.input).toEqual(input)
        expect(part.state.metadata.modelID).toBe(expected)
        expect(part.state.metadata.imagePreview).toBeUndefined()
        expect(part.state.metadata.out).toBe(path.join(e2e.workspace, out))
        expect((await readFile(part.state.metadata.out)).subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
        expect(part.state.content.every((content: { type: string }) => content.type === "text")).toBe(true)
      }
      const imageCount = e2e.proxy.imageRequests
      for (const [label, invalid] of [
        ["prompt", { prompt: null }], ["out", { out: null }], ["model", { model: 42 }],
        ["quality", { quality: "not-a-quality" }], ["size", { size: 42 }], ["images", { images: [null] }],
      ] as const) {
        const id = `call_invalid_image_${label}`
        const marker = `E2E_INVALID_IMAGE_${label}`
        const input: Record<string, unknown> = { prompt: "proof", out: `invalid-${label}.png` }
        Object.assign(input, invalid)
        e2e.proxy.mock.prependFixture({
          match: { userMessage: marker, toolName: "image_gen", hasToolResult: false },
          response: { toolCalls: [{ id, name: "image_gen", arguments: JSON.stringify(input) }] },
        })
        e2e.proxy.mock.prependFixture({ match: { toolCallId: id }, response: { content: "SCHEMA_REJECTED" } })
        await prompt(e2e, sessionID, marker)
        const exported = await api<{ data: { messages: Array<Record<string, any>> } }>(e2e, `/api/experimental/session/${sessionID}/export`)
        const part = exported.data.messages.flatMap((message) => message.content ?? []).find((part) => part.type === "tool" && part.id === id)
        expect(part?.state.status).toBe("error")
        expect(JSON.stringify(part.state)).toContain("Invalid arguments for tool")
        expect(e2e.proxy.imageRequests).toBe(imageCount)
      }
      const session = await api<{ data: { model: { id: string } } }>(e2e, `/api/session/${sessionID}`)
      expect(session.data.model.id).toBe("gpt-5.6-luna")
      expect(e2e.proxy.requests.every((request) => request.model === "gpt-5.6-luna")).toBe(true)
    } finally { await e2e.close() }
  })
}
