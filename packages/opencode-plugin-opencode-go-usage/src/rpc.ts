import { Rpc } from "@opencode/plugin/rpc"

const meter = {
  type: "object",
  properties: {
    percent: { type: "number" },
    limited: { type: "boolean" },
    resetsAt: { type: "number" },
  },
  required: ["percent", "limited", "resetsAt"],
  additionalProperties: false,
} as const

const accountRef = {
  type: "object",
  properties: {
    id: { type: "string" },
    label: { type: "string" },
    active: { type: "boolean" },
  },
  required: ["id", "label", "active"],
  additionalProperties: false,
} as const

const accountUsage = {
  type: "object",
  properties: {
    id: { type: "string" },
    label: { type: "string" },
    active: { type: "boolean" },
    workspace: {
      type: "object",
      properties: {
        id: { type: "string" },
        name: { type: "string" },
      },
      required: ["id"],
      additionalProperties: false,
    },
    state: { type: "string", enum: ["ok", "not_subscribed", "needs_auth", "unsupported", "error"] },
    usage: {
      type: "object",
      properties: {
        rolling: meter,
        weekly: meter,
        monthly: meter,
      },
      required: ["rolling", "weekly", "monthly"],
      additionalProperties: false,
    },
    error: { type: "string" },
  },
  required: ["id", "label", "active", "state"],
  additionalProperties: false,
} as const

const unavailable = { type: "object", additionalProperties: false } as const

export const OpencodeGoUsageRpc = Rpc.define({
  id: "max10240.opencode-go-usage",
  events: {},
  methods: {
    accounts: {
      input: { type: "object", properties: {}, additionalProperties: false },
      output: {
        type: "object",
        properties: {
          accounts: { type: "array", items: accountRef },
        },
        required: ["accounts"],
        additionalProperties: false,
      },
      errors: { unavailable },
    },
    list: {
      input: {
        type: "object",
        properties: { refresh: { type: "boolean" } },
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: {
          accounts: { type: "array", items: accountUsage },
        },
        required: ["accounts"],
        additionalProperties: false,
      },
      errors: { unavailable },
    },
  },
})
