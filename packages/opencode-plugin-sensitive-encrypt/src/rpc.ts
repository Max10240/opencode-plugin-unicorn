import { Rpc } from "@opencode/plugin/rpc"

export const EncryptPreview = Rpc.define({
  id: "max10240.sensitive-encrypt",
  events: {},
  methods: {
    keys: {
      input: { type: "object", properties: {}, additionalProperties: false },
      output: {
        type: "object",
        properties: {
          keys: {
            type: "array",
            items: {
              type: "object",
              properties: {
                role: { type: "string", enum: ["decrypt", "encrypt"] },
                keyID: { type: "string" },
              },
              required: ["role", "keyID"],
              additionalProperties: false,
            },
          },
          defaultRole: { type: "string", enum: ["decrypt", "encrypt"] },
        },
        required: ["keys", "defaultRole"],
        additionalProperties: false,
      },
      errors: { unavailable: { type: "object", additionalProperties: false } },
    },
    encryptText: {
      input: {
        type: "object",
        properties: {
          text: { type: "string" },
          out: { type: "string" },
          key: { type: "string", enum: ["decrypt", "encrypt"] },
        },
        required: ["text"],
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
    encrypt: {
      input: {
        type: "object",
        properties: {
          file: { type: "string" },
          out: { type: "string" },
          key: { type: "string", enum: ["decrypt", "encrypt"] },
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
