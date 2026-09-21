import { Image, ImageClient, ImageInput } from "@opencode/ai"
import type { ImageModel } from "@opencode/ai"
import { Google, Meta, OpenAI, XAI, ZAI } from "@opencode/ai/providers"
import { fetchLayer } from "@opencode/ai/route/executor"
import { Effect, Layer } from "effect"
import { readFile } from "node:fs/promises"
import path from "node:path"
import type { GeneratedImage, ImageFile, ImageQuality } from "./types.js"

export const DEFAULT_OPENAI_IMAGES_BASE_URL = "https://api.openai.com/v1"

export type ImageRequest = {
  readonly baseURL?: string
  readonly headers?: Readonly<Record<string, string>>
  readonly token: string
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

type ProviderFactory = {
  readonly configure: (input?: Record<string, unknown>) => { readonly image: (modelID: string) => ImageModel }
}

const MIME_TYPES: Record<string, string> = {
  ".gif": "image/gif",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
}

const imageClientLayer = ImageClient.layer.pipe(Layer.provide(fetchLayer))
const CORE_SETTINGS = new Set(["chunkTimeout", "compaction", "fetch", "timeout", "transport"])

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
  const packageName = normalizePackage(request.packageName)
  const provider = await loadProviderFactory(packageName, request.providerID, request.baseURL)
  const settings = nativeSettings(request.settings)
  const configuredBaseURL = typeof settings.baseURL === "string" ? settings.baseURL : undefined
  const input: Record<string, unknown> = {
    ...settings,
    apiKey: request.token,
    baseURL: request.baseURL ?? configuredBaseURL,
    headers: request.headers === undefined ? undefined : { ...request.headers },
    http: request.body === undefined ? undefined : { body: { ...request.body } },
  }
  const model = provider.configure(input).image(request.model)
  const response = await Effect.runPromise(
    Image.generate({
      model,
      prompt: request.prompt,
      images: (request.images ?? []).map((image) => ImageInput.bytes(image.data, image.mediaType)),
      options: imageOptions(packageName, request.quality, request.size) as Record<string, unknown>,
    }).pipe(Effect.provide(imageClientLayer)),
  )
  const image = response.image
  if (!image) throw new Error(`Image provider ${packageName ?? "openai-compatible"} returned no image data.`)
  if (image.data instanceof Uint8Array) return { data: image.data, mediaType: image.mediaType }
  if (image.data.startsWith("data:")) return decodeDataUrl(image.data, image.mediaType)

  const downloaded = await fetch(image.data)
  if (!downloaded.ok) throw new Error(`Generated image download failed (${downloaded.status}).`)
  return { data: new Uint8Array(await downloaded.arrayBuffer()), mediaType: image.mediaType }
}

function nativeSettings(settings: Readonly<Record<string, unknown>> | undefined): Record<string, unknown> {
  return Object.fromEntries(Object.entries(settings ?? {}).filter(([key]) => !CORE_SETTINGS.has(key)))
}

function normalizePackage(packageName: string | undefined): string | undefined {
  if (!packageName) return undefined
  if (packageName.startsWith("aisdk:")) return packageName.slice("aisdk:".length)
  if (packageName.startsWith("@opencode-ai/ai/")) return packageName.replace("@opencode-ai/", "@opencode/")
  return packageName
}

async function loadProviderFactory(
  packageName: string | undefined,
  providerID: string,
  baseURL: string | undefined,
): Promise<ProviderFactory> {
  const builtIn = builtInProvider(packageName)
  if (builtIn) return builtIn

  // Custom native provider packages can expose the same configure().image()
  // surface as @opencode/ai. If they do not, fall back to the standard
  // OpenAI Images wire format, which is what openai-compatible providers use.
  if (packageName && !packageName.startsWith("@ai-sdk/") && !packageName.startsWith("@opencode/ai/providers/openai-compatible")) {
    try {
      const module = (await import(packageName)) as Partial<ProviderFactory>
      if (typeof module.configure === "function") {
        const configured = module.configure({ baseURL })
        if (typeof configured?.image === "function") return module as ProviderFactory
      }
    } catch {
      // OpenCode may have installed a custom package in its own package cache;
      // the generic OpenAI Images adapter remains usable from the configured URL.
    }
  }
  if (providerID === "openai" || packageName?.startsWith("@opencode/ai/providers/openai-compatible") || baseURL) {
    return OpenAI as unknown as ProviderFactory
  }
  throw new Error(
    `Provider ${providerID} package ${packageName ?? "unknown"} does not expose an image adapter. ` +
      "Use an OpenCode image provider or configure an OpenAI-compatible Images endpoint.",
  )
}

function builtInProvider(packageName: string | undefined): ProviderFactory | undefined {
  if (packageName === "@opencode/ai/providers/google") return Google as unknown as ProviderFactory
  if (packageName === "@opencode/ai/providers/meta") return Meta as unknown as ProviderFactory
  if (packageName === "@opencode/ai/providers/xai") return XAI as unknown as ProviderFactory
  if (packageName === "@opencode/ai/providers/zai") return ZAI as unknown as ProviderFactory
  if (packageName === "@opencode/ai/providers/openai") return OpenAI as unknown as ProviderFactory
  // openai-compatible, custom OpenAI-compatible packages, and image-only
  // models not present in the language catalog use OpenAI's Images protocol.
  return undefined
}

function imageOptions(packageName: string | undefined, quality: ImageQuality | undefined, size: string | undefined) {
  if (packageName === "@opencode/ai/providers/google") {
    return {
      ...(size ? googleSize(size) : {}),
      ...(quality ? { thinkingLevel: quality.toUpperCase() } : {}),
    }
  }
  if (packageName === "@opencode/ai/providers/xai") {
    return {
      n: 1,
      responseFormat: "b64_json",
      ...(size ? { aspectRatio: sizeToAspectRatio(size), resolution: sizeToResolution(size) } : {}),
    }
  }
  if (packageName === "@opencode/ai/providers/zai") {
    return { ...(size ? { size } : {}), ...(quality ? { quality: quality === "high" ? "hd" : "standard" } : {}) }
  }
  if (packageName === "@opencode/ai/providers/meta") {
    return { n: 1, outputFormat: "png", responseFormat: "b64_json", ...(size ? { size } : {}) }
  }
  return {
    n: 1,
    outputFormat: "png",
    ...(quality ? { quality } : {}),
    ...(size ? { size } : {}),
  }
}

function googleSize(size: string): Record<string, string> {
  const [width, height] = size.split("x").map(Number)
  if (!Number.isFinite(width) || !Number.isFinite(height)) return { aspectRatio: size }
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

function sizeToAspectRatio(size: string): string {
  const [width, height] = size.split("x").map(Number)
  if (!Number.isFinite(width) || !Number.isFinite(height)) return size
  const ratio = width / height
  if (Math.abs(ratio - 1) < 0.05) return "1:1"
  if (ratio > 1.5) return "16:9"
  if (ratio > 1) return "4:3"
  if (ratio < 0.67) return "9:16"
  return "3:4"
}

function sizeToResolution(size: string): string {
  const [width, height] = size.split("x").map(Number)
  return Math.max(width || 0, height || 0) > 1024 ? "2k" : "1k"
}

function decodeDataUrl(value: string, mediaType: string): GeneratedImage {
  const separator = value.indexOf(",")
  if (separator < 0) throw new Error("Generated image data URL is invalid.")
  return { data: Uint8Array.from(Buffer.from(value.slice(separator + 1), "base64")), mediaType }
}
