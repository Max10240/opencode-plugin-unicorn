import { Rpc } from "@opencode/plugin/rpc"

const runtime = {
  type: "object",
  properties: {
    version: { type: "string" },
    packagePath: { type: "string" },
    shadow: { type: "boolean" },
    repo: { type: "string" },
    commit: { type: "string" },
    dirty: { type: "boolean" },
  },
  required: ["version", "packagePath", "shadow"],
  additionalProperties: false,
} as const

export const UnicornStatusRpc = Rpc.define({
  id: "max10240.unicorn.status",
  events: {},
  methods: {
    runtime: {
      input: { type: "object", properties: {}, additionalProperties: false },
      output: runtime,
      errors: { unavailable: { type: "object", additionalProperties: false } },
    },
  },
})
