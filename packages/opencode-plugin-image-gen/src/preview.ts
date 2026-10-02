import type { Context } from "@opencode/plugin/promise/plugin"
import type { ToolContext } from "@opencode/plugin/promise/tool"

// Discover at execution time: show-img is optional and may load later or be disabled.
export async function prepareImagePreview(context: Pick<Context, "tool">, tool: ToolContext, savedPath: string) {
  try {
    const preview = (await context.tool.list()).find((entry) => entry.id === "show_img")
    if (!preview) return
    const result = await preview.execute({ abs_file_path: savedPath }, tool)
    const reference: unknown = result.metadata?.imagePreview
    if (typeof reference !== "object" || reference === null) return
    const { assetID, name } = reference as Record<string, unknown>
    if (typeof assetID !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(assetID)) return
    if (typeof name !== "string" || !name) return
    // Do not forward the other tool's content, output, or arbitrary metadata to the model.
    return { assetID, name }
  } catch {
    // The image is already saved. Optional preview failure must not turn generation into failure.
    return
  }
}
