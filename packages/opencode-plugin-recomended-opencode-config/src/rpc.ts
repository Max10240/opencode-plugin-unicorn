import { Rpc } from "@opencode/plugin/rpc"

const status = {
  type: "object",
  properties: {
    directory: { type: "string" },
    configFiles: { type: "array", items: { type: "string" } },
    enabled: { type: "boolean" },
    rules: {
      type: "object",
      properties: {
        total: { type: "number" },
        present: { type: "number" },
        missing: { type: "array", items: { type: "string" } },
      },
      required: ["total", "present", "missing"],
      additionalProperties: false,
    },
    commands: {
      type: "object",
      properties: {
        total: { type: "number" },
        present: { type: "array", items: { type: "string" } },
        missing: { type: "array", items: { type: "string" } },
      },
      required: ["total", "present", "missing"],
      additionalProperties: false,
    },
  },
  required: ["directory", "configFiles", "enabled", "rules", "commands"],
  additionalProperties: false,
} as const

export const RecommendedStatusRpc = Rpc.define({
  id: "max10240.recommended-opencode-config",
  events: {},
  methods: {
    status: {
      input: { type: "object", properties: {}, additionalProperties: false },
      output: status,
      errors: { unavailable: { type: "object", additionalProperties: false } },
    },
  },
})
