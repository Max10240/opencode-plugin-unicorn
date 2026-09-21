import { Image, ImageClient, ImageInput } from "@opencode/ai"
import { OpenAI } from "@opencode/ai/providers"
import { fetchLayer } from "@opencode/ai/route/executor"
import { Effect, Layer } from "effect"
import { readFile } from "node:fs/promises"
import path from "node:path"
import type { GeneratedImage, ImageFile, ImageQuality } from "./types.js"

export const DEFAULT_OPENAI_IMAGES_BASE_URL = "https://api.openai.com/v1"

export type OpenAIImageRequest = {
  readonly baseURL?: string
  readonly headers?: Readonly<Record<string, string>>
  readonly token: string
  readonly model: string
  readonly prompt: string
  readonly quality?: ImageQuality
  readonly size?: string
  readonly images?: readonly ImageFile[]
}

const MIME_TYPES: Record<string, string> = {
  ".gif": "image/gif",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
}

const imageClientLayer = ImageClient.layer.pipe(Layer.provide(fetchLayer))

export async function readImageFiles(paths: readonly string[] | undefined, directory: string): Promise<ImageFile[]> {
  return Promise.all(
    (paths ?? []).map(async (filePath) => {
      const absolutePath = path.isAbsolute(filePath) ? filePath : path.resolve(directory, filePath)
      const mediaType = MIME_TYPES[path.extname(absolutePath).toLowerCase()]
      if (!mediaType) throw new Error(`Unsupported image file type: ${absolutePath}`)
      return {
        path: absolutePath,
        name: path.basename(absolutePath),
        mediaType,
        data: new Uint8Array(await readFile(absolutePath)),
      }
    }),
  )
}

export async function generateOpenAIImage(request: OpenAIImageRequest): Promise<GeneratedImage> {
  const images = request.images ?? []
  const model = OpenAI.configure({
    apiKey: request.token,
    baseURL: request.baseURL ?? DEFAULT_OPENAI_IMAGES_BASE_URL,
    headers: request.headers === undefined ? undefined : { ...request.headers },
  }).image(request.model)
  const response = await Effect.runPromise(
    Image.generate({
      model,
      prompt: request.prompt,
      images: images.map((image) => ImageInput.bytes(image.data, image.mediaType)),
      options: {
        n: 1,
        outputFormat: "png",
        ...(request.quality ? { quality: request.quality } : {}),
        ...(request.size ? { size: request.size } : {}),
      },
    }).pipe(Effect.provide(imageClientLayer)),
  )
  const image = response.image
  if (!image) throw new Error("OpenAI Images returned no image data.")
  if (image.data instanceof Uint8Array) return { data: image.data, mediaType: image.mediaType }
  if (image.data.startsWith("data:")) return decodeDataUrl(image.data, image.mediaType)

  const downloaded = await fetch(image.data)
  if (!downloaded.ok) throw new Error(`Generated image download failed (${downloaded.status}).`)
  return { data: new Uint8Array(await downloaded.arrayBuffer()), mediaType: image.mediaType }
}

function decodeDataUrl(value: string, mediaType: string): GeneratedImage {
  const separator = value.indexOf(",")
  if (separator < 0) throw new Error("Generated image data URL is invalid.")
  return { data: Uint8Array.from(Buffer.from(value.slice(separator + 1), "base64")), mediaType }
}
