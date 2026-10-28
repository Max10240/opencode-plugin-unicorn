import { Rpc } from "@opencode/plugin/rpc"

export const EncryptPreview = Rpc.define({
  id: "max10240.sensitive-encrypt",
  events: {},
  methods: {
    encrypt: {
      input: {
        type: "object",
        properties: {
          file: { type: "string" },
          out: { type: "string" },
        },
        required: ["file"],
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: {
          ciphertext: { type: "string" },
          out: { type: "string" },
          keyID: { type: "string" },
          bytes: { type: "number" },
        },
        required: ["keyID", "bytes"],
        additionalProperties: false,
      },
      errors: {
        unavailable: { type: "object", additionalProperties: false },
      },
    },
  },
})
