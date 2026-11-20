import type { Context } from "@opencode/plugin/promise/plugin"
import { Plugin } from "@opencode/plugin"
import { Error as ToolError } from "@opencode/plugin/promise/tool"
import { createPreviewAssets } from "./preview-assets.js"
import { ImagePreview, showImgEnabled, type PreviewReference } from "./preview-rpc.js"

export default Plugin.define({
  id: "max10240.show-img",
  setup(context) {
    if (showImgEnabled(context.options)) return setupShowImg(context)
  },
})

export async function setupShowImg(context: Context) {
  if (!showImgEnabled(context.options)) return async () => {}
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
        description: "Show one or more server-side images to the user without adding them to model context. Supports PNG, JPEG, GIF and WebP up to 20 MiB each.",
        input: {
          type: "object",
          properties: {
            abs_file_path: { type: "string", description: "Absolute image file path on the server. Pass this or abs_file_paths." },
            abs_file_paths: {
              type: "array",
              items: { type: "string" },
              minItems: 1,
              description: "Absolute image file paths on the server. Pass this or abs_file_path.",
            },
          },
          required: [],
          additionalProperties: false,
        },
        execute: async (rawInput, tool) => {
          const input = rawInput as { abs_file_path?: unknown; abs_file_paths?: unknown }
          const single = input.abs_file_path !== undefined
          const multiple = input.abs_file_paths !== undefined
          if (single && multiple) {
            throw new ToolError({ message: "Use abs_file_path or abs_file_paths, not both" })
          }
          if (!single && !multiple) {
            throw new ToolError({ message: "Pass abs_file_path or abs_file_paths" })
          }
          const values = single ? [input.abs_file_path] : input.abs_file_paths
          if (!Array.isArray(values) || values.length === 0 || values.some((value) => typeof value !== "string" || !value.trim())) {
            throw new ToolError({ message: "Provide one or more absolute image paths" })
          }
          const paths = [...new Set(values.map((value) => value.trim()))]
          const references: PreviewReference[] = []
          try {
            for (const path of paths) references.push(await assets.register(tool.sessionID, path))
            return {
              content: references.length === 1
                ? "Image preview prepared for the user. Image content was not added to model context."
                : `${references.length} image previews prepared for the user. Image content was not added to model context.`,
              metadata: { imagePreview: references[0], imagePreviews: references },
            }
          } catch (error) {
            await Promise.allSettled(references.map((reference) => assets.remove(reference.assetID)))
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
