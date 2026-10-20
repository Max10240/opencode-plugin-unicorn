import { Plugin } from "@opencode/plugin"
import type { Context } from "@opencode/plugin/promise/plugin"
import { credentialSettings, resolveCredential } from "./credential.js"
import { DEFAULT_IMAGE_MODEL, resolveImageModel } from "./model.js"
import { generateImage, readImageFiles } from "./openai-images.js"
import { saveGeneratedImage } from "./output.js"
import { prepareImagePreview } from "./preview.js"
import type { ImageGenOptions, ImageToolInput } from "./types.js"

const TOOL_NAME = "image_gen"

export async function setupImageGen(context: Context) {
  const options = context.options as ImageGenOptions
  const registration = await context.tool.transform((editor) => {
    editor.add({
      name: TOOL_NAME,
      options: { codemode: false },
      description: "Generate or edit one image and save it to a file without overwriting existing files.",
      input: {
        type: "object",
        properties: {
          prompt: { type: "string", description: "Image description or editing instructions." },
          out: {
            type: "string",
            description: "Output path, relative to the current session directory unless absolute.",
          },
          model: {
            type: "string",
            description: `Provider/model with optional #variant; defaults to options.model or ${DEFAULT_IMAGE_MODEL}.`,
          },
          quality: {
            type: "string",
            enum: ["low", "medium", "high", "xhigh", "max", "auto"],
            description: "Image quality; xhigh and max require GPT Image 2.5.",
          },
          size: { type: "string", description: "Image size, for example 1024x1024." },
          images: {
            type: "array",
            items: { type: "string" },
            description: "Reference image paths for editing, relative to the session directory unless absolute.",
          },
        },
        required: ["prompt", "out"],
        additionalProperties: false,
      },
      execute: async (rawInput, tool) => {
        const input = rawInput as ImageToolInput
        const model = await resolveImageModel(context, tool.sessionID, input.model)

        const credential = await resolveCredential(context, model.integrationID)
        const images = await readImageFiles(input.images, model.directory)
        const runtime = credentialSettings(model.settings, model.body, credential)
        const runtimeSettings = runtime.settings
        const headers = { ...model.headers }
        await tool.progress({ status: `Requesting image from ${model.providerID}/${model.modelID}` })
        const image = await generateImage(
          {
            baseURL:
              typeof options.baseURL === "string"
                ? resolveEnvironmentURL(options.baseURL)
                : resolveEnvironmentURL(runtimeSettings.baseURL) ?? model.baseURL,
            headers,
            token: credential?.value,
            credentialType: credential?.source === "oauth" ? "oauth" : credential ? "key" : undefined,
            activation: model.activation,
            canonical: model.canonical,
            sessionID: tool.sessionID,
            signal: (tool as typeof tool & { readonly signal?: AbortSignal }).signal,
            providerID: model.providerID,
            model: model.modelID,
            packageName: model.packageName,
            settings: runtimeSettings,
            body: runtime.body,
            prompt: input.prompt,
            quality: input.quality,
            size: input.size,
            images,
          },
        )
        const saved = await saveGeneratedImage(input.out, model.directory, image.data)
        const imagePreview = await prepareImagePreview(context, tool, saved.savedPath)
        return {
          content: saved.message,
          metadata: {
            out: saved.savedPath,
            versioned: saved.versioned,
            providerID: model.providerID,
            modelID: model.modelID,
            package: model.packageName,
            endpoint: images.length === 0 ? "/images/generations" : "/images/edits",
            credentialSource: credential?.source ?? "provider",
            ...(model.variant ? { variant: model.variant } : {}),
            ...(imagePreview ? { imagePreview } : {}),
          },
        }
      },
    })
  })
  return () => registration.dispose()
}

export default Plugin.define({
  id: "opencode.image-gen",
  setup: setupImageGen,
})

function resolveEnvironmentURL(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined
  return value.replace(/\$\{([^}]+)\}/g, (placeholder, name: string) => process.env[name] ?? placeholder)
}
