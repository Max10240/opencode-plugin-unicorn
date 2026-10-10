import type { Context } from "@opencode/plugin/promise/plugin"
import { Plugin } from "@opencode/plugin"
import { Error as ToolError } from "@opencode/plugin/promise/tool"
import { createPreviewAssets } from "./preview-assets.js"
import { ImagePreview, showImgEnabled } from "./preview-rpc.js"

export default Plugin.define({
  id: "max10240.show-img",
  setup(context) {
    if (showImgEnabled(context.options)) return setupShowImg(context)
  },
})

export async function setupShowImg(context: Context) {
  const assets = createPreviewAssets(context.storage)
  const rpc = await context.rpc.register(ImagePreview, {
    read: async (rawInput, request) => {
      const input = rawInput as { sessionID: string; assetID: string }
      try {
        return await assets.read(input.sessionID, input.assetID, request.signal)
      } catch {
        return request.error("unavailable", "Image preview is unavailable", {})
      }
    },
  })
  try {
    const registration = await context.tool.transform((editor) => {
      editor.add({
        name: "show_img",
        options: { codemode: false },
        description: "Show a server-side image to the user without adding it to model context. Supports PNG, JPEG, GIF and WebP up to 20 MiB.",
        input: {
          type: "object",
          properties: { abs_file_path: { type: "string", description: "Absolute image file path on the server." } },
          required: ["abs_file_path"],
          additionalProperties: false,
        },
        execute: async (rawInput, tool) => {
          const input = rawInput as { abs_file_path: string }
          try {
            const reference = await assets.register(tool.sessionID, input.abs_file_path)
            return {
              content: "Image preview prepared for the user. Image content was not added to model context.",
              metadata: { imagePreview: reference },
            }
          } catch (error) {
            throw new ToolError({ message: error instanceof Error ? error.message : "Could not prepare image preview" })
          }
        },
      })
    })
    return async () => {
      try { await registration.dispose() } finally { await rpc.dispose() }
    }
  } catch (error) {
    await rpc.dispose()
    throw error
  }
}
