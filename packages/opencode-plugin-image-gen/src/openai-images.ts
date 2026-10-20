import { Media } from "@opencode/ai"
import { make as makeAIClient } from "@opencode/ai/promise"
import { fetchLayer } from "@opencode/ai/route/executor"
import { readFile } from "node:fs/promises"
import path from "node:path"
import type { GeneratedImage, ImageFile, ImageQuality } from "./types.js"
import { prepareImageModel } from "./deployment.js"
import { openAIURLImage } from "./openai-url-result.js"

export const DEFAULT_OPENAI_IMAGES_BASE_URL = "https://api.openai.com/v1"

export type ImageRequest = {
  readonly baseURL?: string
  readonly headers?: Readonly<Record<string, string>>
  readonly token?: string
  readonly credentialType?: "key" | "oauth"
  readonly activation?: "auto" | "enabled" | "disabled"
  readonly canonical?: string
  readonly sessionID?: string
  readonly signal?: AbortSignal
  readonly providerID: string
  readonly model: string
  readonly packageName?: string
  readonly settings?: Readonly<Record<string, unknown>>
  readonly body?: Readonly<Record<string, unknown>>
  readonly prompt: string
  readonly quality?: ImageQuality
  readonly size?: string
  readonly images?: readonly ImageFile[]
}

type ImageGenerationOptions = {
  readonly n?: number
  readonly size?: `${number}x${number}`
  readonly aspectRatio?: `${number}:${number}`
  readonly format?: string
  readonly providerOptions?: Readonly<Record<string, unknown>>
}

type ParsedImageSize = {
  readonly dimensions?: `${number}x${number}`
  readonly aspectRatio?: `${number}:${number}`
  readonly raw?: string
}

const MIME_TYPES: Record<string, string> = {
  ".gif": "image/gif",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
}

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

export async function generateImage(request: ImageRequest): Promise<GeneratedImage> {
  request.signal?.throwIfAborted()
  const { model, family } = await prepareImageModel(request)
  const size = request.size === undefined ? undefined : parseImageSize(request.size)
  const imageClient = makeAIClient({ layer: fetchLayer })
  try {
    const response = await imageClient.image.generate({
      model,
      prompt: request.prompt,
      images: (request.images ?? []).map((image) => Media.bytes(image.data, image.mediaType)),
      ...imageOptions(family, request.quality, size),
      ...(request.sessionID ? { http: { headers: { "x-opencode-session-id": request.sessionID } } } : {}),
    }, { signal: request.signal }).catch((error: unknown) => {
      const image = model.route.id === "openai-images" ? openAIURLImage(error) : undefined
      if (!image) throw error
      return { image }
    })
    const image = response.image
    if (!image) throw new Error(`Image provider ${request.providerID} returned no image data.`)
    const dataUrl = image.source.type === "url" ? Media.parseDataUrl(image.source.url) : undefined
    const materialized = dataUrl ?? (await imageClient.run(image.materialize(), { signal: request.signal }))
    return { data: await imageClient.run(materialized.bytes(), { signal: request.signal }), mediaType: materialized.mediaType }
  } finally {
    await imageClient.dispose()
  }
}

function imageOptions(
  packageName: string | undefined,
  quality: ImageQuality | undefined,
  size: ParsedImageSize | undefined,
): ImageGenerationOptions {
  if (packageName === "@opencode/ai/providers/google") {
    const dimensions = size?.dimensions ? googleSize(size.dimensions) : undefined
    const aspectRatio = size?.aspectRatio ?? dimensions?.aspectRatio
    return {
      ...(aspectRatio ? { aspectRatio } : {}),
      providerOptions: {
        ...(size?.raw !== undefined ? { imageConfig: { aspectRatio: size.raw } } : {}),
        ...(dimensions?.imageSize ? { imageSize: dimensions.imageSize } : {}),
        ...(quality ? { thinkingLevel: quality.toUpperCase() } : {}),
      },
    }
  }
  if (packageName === "@opencode/ai/providers/xai") {
    const aspectRatio = size?.aspectRatio ?? (size?.dimensions ? sizeToAspectRatio(size.dimensions) : undefined)
    return {
      n: 1,
      ...(aspectRatio ? { aspectRatio } : {}),
      providerOptions: {
        responseFormat: "b64_json",
        ...(size?.raw !== undefined ? { aspect_ratio: size.raw } : {}),
        ...(size
          ? { resolution: size.dimensions ? sizeToResolution(size.dimensions) : "1k" }
          : {}),
      },
    }
  }
  if (packageName === "@opencode/ai/providers/zai") {
    const providerSize = size?.aspectRatio ?? size?.raw
    return {
      ...(size?.dimensions ? { size: size.dimensions } : {}),
      providerOptions: {
        ...(providerSize !== undefined ? { size: providerSize } : {}),
        ...(quality ? { quality: quality === "high" ? "hd" : "standard" } : {}),
      },
    }
  }
  if (packageName === "@opencode/ai/providers/meta") {
    const providerSize = size?.aspectRatio ?? size?.raw
    return {
      n: 1,
      format: "png",
      ...(size?.dimensions ? { size: size.dimensions } : {}),
      providerOptions: {
        responseFormat: "b64_json",
        ...(providerSize !== undefined ? { size: providerSize } : {}),
      },
    }
  }
  const providerSize = size?.aspectRatio ?? size?.raw
  return {
    n: 1,
    format: "png",
    ...(size?.dimensions ? { size: size.dimensions } : {}),
    providerOptions: {
      ...(providerSize !== undefined ? { size: providerSize } : {}),
      ...(quality ? { quality } : {}),
    },
  }
}

function parseImageSize(size: string): ParsedImageSize {
  const match = /^([1-9]\d*)x([1-9]\d*)$/.exec(size)
  if (match && Number.isSafeInteger(Number(match[1])) && Number.isSafeInteger(Number(match[2]))) {
    return { dimensions: size as `${number}x${number}` }
  }

  const ratio = /^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/.exec(size)
  if (
    ratio &&
    Number.isFinite(Number(ratio[1])) &&
    Number.isFinite(Number(ratio[2])) &&
    Number(ratio[1]) > 0 &&
    Number(ratio[2]) > 0
  ) {
    return { aspectRatio: size as `${number}:${number}` }
  }

  return { raw: size }
}

function googleSize(size: `${number}x${number}`): { readonly aspectRatio: `${number}:${number}`; readonly imageSize?: string } {
  const [width, height] = size.split("x").map(Number)
  const ratio = width / height
  const aspectRatio =
    Math.abs(ratio - 1) < 0.05
      ? "1:1"
      : ratio > 1
        ? ratio > 1.5
          ? "16:9"
          : "4:3"
        : ratio < 0.67
          ? "9:16"
          : "3:4"
  return { aspectRatio, imageSize: Math.max(width, height) >= 2048 ? "2K" : "1K" }
}

function sizeToAspectRatio(size: `${number}x${number}`): `${number}:${number}` {
  const [width, height] = size.split("x").map(Number)
  const ratio = width / height
  if (Math.abs(ratio - 1) < 0.05) return "1:1"
  if (ratio > 1.5) return "16:9"
  if (ratio > 1) return "4:3"
  if (ratio < 0.67) return "9:16"
  return "3:4"
}

function sizeToResolution(size: `${number}x${number}`): string {
  const [width, height] = size.split("x").map(Number)
  return Math.max(width || 0, height || 0) > 1024 ? "2k" : "1k"
}
