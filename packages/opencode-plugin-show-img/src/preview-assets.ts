import { randomUUID } from "node:crypto"
import { open, readFile, realpath } from "node:fs/promises"
import path from "node:path"
import type { Context } from "@opencode/plugin/promise/plugin"
import type { PreviewImage } from "./preview-rpc.js"

const PREFIX = "show-img/"
export const MAX_PREVIEW_BYTES = 20 * 1024 * 1024

type Asset = { sessionID: string; path: string; mime: string; name: string }

export function createPreviewAssets(storage: Pick<Context["storage"], "get" | "set">) {
  return {
    async register(sessionID: string, absFilePath: string) {
      if (!path.isAbsolute(absFilePath)) throw new Error("abs_file_path must be an absolute server-side file path")
      const resolved = await realpath(absFilePath)
      const mime = await inspectImage(resolved)
      const assetID = randomUUID()
      const name = path.basename(resolved)
      // Durable references only: never store image bytes in session or plugin metadata.
      await storage.set(`${PREFIX}${assetID}`, { sessionID, path: resolved, mime, name })
      return { assetID, name }
    },
    async read(sessionID: string, assetID: string, signal?: AbortSignal): Promise<PreviewImage> {
      const asset = await storage.get(`${PREFIX}${assetID}`) as Asset | undefined
      if (!asset || asset.sessionID !== sessionID) throw new Error("Image preview is unavailable for this session")
      const mime = await inspectImage(asset.path)
      if (mime !== asset.mime) throw new Error("The image file type has changed")
      const data = await readFile(asset.path, { signal })
      if (data.length > MAX_PREVIEW_BYTES) throw new Error("Image exceeds the 20 MiB preview limit")
      return { mime, data: data.toString("base64"), name: asset.name }
    },
  }
}

async function inspectImage(file: string) {
  const handle = await open(file, "r")
  try {
    const info = await handle.stat()
    if (!info.isFile()) throw new Error("Image preview requires a regular file")
    if (info.size > MAX_PREVIEW_BYTES) throw new Error("Image exceeds the 20 MiB preview limit")
    const bytes = Buffer.alloc(16)
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0)
    const header = bytes.subarray(0, bytesRead)
    if (header.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png"
    if (header.length >= 3 && header[0] === 255 && header[1] === 216 && header[2] === 255) return "image/jpeg"
    if (["GIF87a", "GIF89a"].includes(header.subarray(0, 6).toString("ascii"))) return "image/gif"
    if (header.subarray(0, 4).toString("ascii") === "RIFF" && header.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp"
    throw new Error("Only PNG, JPEG, GIF and WebP images can be previewed")
  } finally {
    await handle.close()
  }
}
