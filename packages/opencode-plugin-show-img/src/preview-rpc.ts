import { Rpc } from "@opencode/plugin/rpc"

// This is a client/server UI transport, never an agent tool or tool-result schema.
export const ImagePreview = Rpc.define({
  id: "max10240.show-img",
  events: {},
  methods: {
    read: {
      input: {
        type: "object",
        properties: { assetID: { type: "string" }, sessionID: { type: "string" } },
        required: ["assetID", "sessionID"],
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: { mime: { type: "string" }, data: { type: "string" }, name: { type: "string" } },
        required: ["mime", "data", "name"],
        additionalProperties: false,
      },
      errors: { unavailable: { type: "object", additionalProperties: false } },
    },
  },
})

export type PreviewReference = { assetID: string; name: string }
export type PreviewImage = { mime: string; data: string; name: string }

export function previewReference(metadata: Readonly<Record<string, unknown>> | undefined): PreviewReference | undefined {
  const value = metadata?.imagePreview
  if (!value || typeof value !== "object") return
  if (!("assetID" in value) || typeof value.assetID !== "string") return
  if (!("name" in value) || typeof value.name !== "string") return
  return { assetID: value.assetID, name: value.name }
}

export function showImgEnabled(options: Readonly<Record<string, unknown>>): boolean {
  const features = options.features
  return !features || typeof features !== "object" || !("showImg" in features) || features.showImg !== false
}
