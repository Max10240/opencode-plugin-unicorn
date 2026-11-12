import { Rpc } from "@opencode/plugin/rpc"

export type ProtectionHit = {
  readonly kind: "blocked" | "redacted" | "error"
  readonly source: "read" | "tool" | "context" | "http" | "parser"
  readonly count: number
  readonly label?: string
  readonly file?: string
  readonly tool?: string
}

export const ProtectionRpc = Rpc.define({
  id: "max10240.sensitive-protection",
  events: {
    hit: {
      schema: {
        type: "object",
        properties: {
          kind: { type: "string", enum: ["blocked", "redacted", "error"] },
          source: { type: "string", enum: ["read", "tool", "context", "http", "parser"] },
          count: { type: "number" },
          label: { type: "string" },
          file: { type: "string" },
          tool: { type: "string" },
        },
        required: ["kind", "source", "count"],
        additionalProperties: false,
      },
    },
  },
  methods: {},
})
