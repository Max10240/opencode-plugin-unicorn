import { Plugin } from "@opencode/plugin"
import { resolveCredential } from "./credential.js"
import { resolveImageModel } from "./model.js"
import { generateOpenAIImage, readImageFiles } from "./openai-images.js"
import { saveGeneratedImage } from "./output.js"
import type { ImageGenOptions, ImageToolInput } from "./types.js"

const TOOL_NAME = "image_gen"

export default Plugin.define({
  id: "opencode.image-gen",
  async setup(context) {
    const options = context.options as ImageGenOptions
    await context.tool.transform((editor) => {
      editor.add({
        name: TOOL_NAME,
        options: { codemode: false },
        description: [
          "Generate one raster image through the selected provider's standard OpenAI-compatible Images API.",
          "The tool uses /images/generations without reference images and /images/edits with reference images.",
          "If model is omitted, use the current session model; configure image_gen.model to select a dedicated image model.",
          "This feasibility implementation currently accepts the openai provider only and never uses the Codex Responses or hosted image_generation tool.",
          "Existing output files are never overwritten; the tool writes -v2, -v3, and so on.",
        ].join(" "),
        input: {
          type: "object",
          properties: {
            prompt: { type: "string", description: "Description of the image to generate." },
            out: {
              type: "string",
              description: "Output path, relative to the current session directory unless absolute.",
            },
            model: {
              type: "string",
              description: "Optional model reference, for example openai/gpt-image-1.",
            },
            quality: {
              type: "string",
              enum: ["low", "medium", "high", "auto"],
              description: "Optional image quality passed to the provider.",
            },
            size: { type: "string", description: "Optional image size such as 1024x1024." },
            images: {
              type: "array",
              items: { type: "string" },
              description: "Optional reference image paths, relative to the current session directory.",
            },
          },
          required: ["prompt", "out"],
          additionalProperties: false,
        },
        execute: async (rawInput, tool) => {
          const input = rawInput as ImageToolInput
          const model = await resolveImageModel(context, tool.sessionID, input.model)
          if (model.providerID !== "openai") {
            throw new Error(
              `The image_gen feasibility PoC only supports provider openai; received ${model.providerID}.`,
            )
          }

          const credential = await resolveCredential(context, model.integrationID, model.providerID)
          const images = await readImageFiles(input.images, model.directory)
          const headers = { ...model.headers }
          if (credential.source === "oauth" && credential.metadata) {
            const hasAccountHeader = Object.keys(headers).some((key) => key.toLowerCase() === "chatgpt-account-id")
            const accountID = credential.metadata.accountID ?? credential.metadata.accountId
            if (!hasAccountHeader && typeof accountID === "string") headers["chatgpt-account-id"] = accountID
          }
          await tool.progress({ status: `Requesting image from ${model.providerID}/${model.modelID}` })
          const image = await generateOpenAIImage(
            {
              baseURL: typeof options.baseURL === "string" ? options.baseURL : model.baseURL,
              headers,
              token: credential.value,
              model: model.modelID,
              prompt: input.prompt,
              quality: input.quality,
              size: input.size,
              images,
            },
          )
          const saved = await saveGeneratedImage(input.out, model.directory, image.data)
          return {
            content: saved.message,
            metadata: {
              out: saved.savedPath,
              versioned: saved.versioned,
              providerID: model.providerID,
              modelID: model.modelID,
              endpoint: images.length === 0 ? "/images/generations" : "/images/edits",
              credentialSource: credential.source,
            },
          }
        },
      })
    })
  },
})
