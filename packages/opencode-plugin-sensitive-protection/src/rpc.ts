import { Rpc } from "@opencode/plugin/rpc"
import type { ProtectionHit } from "./types.js"

export type { ProtectionHit, ProtectionMatch, ProtectionSource } from "./types.js"

const match = {
  type: "object",
  properties: {
    file: { type: "string" },
    label: { type: "string" },
    source: { type: "string", enum: ["manual", "builtin", "custom"] },
    key: { type: "string" },
    count: { type: "number" },
  },
  required: ["count"],
  additionalProperties: false,
} as const

const hit = {
  type: "object",
  properties: {
    id: { type: "string" },
    time: { type: "number" },
    firstTime: { type: "number" },
    occurrences: { type: "number" },
    kind: { type: "string", enum: ["blocked", "redacted", "error"] },
    source: { type: "string", enum: ["read", "tool", "context", "http", "parser"] },
    count: { type: "number" },
    label: { type: "string" },
    file: { type: "string" },
    tool: { type: "string" },
    sessionID: { type: "string" },
    detail: { type: "string" },
    matches: { type: "array", items: match },
  },
  required: ["id", "time", "firstTime", "occurrences", "kind", "source", "count"],
  additionalProperties: false,
} as const

const empty = { type: "object", properties: {}, additionalProperties: false } as const

export const ProtectionRpc = Rpc.define({
  id: "max10240.sensitive-protection",
  events: {
    hit: { schema: hit },
    cleared: { schema: { type: "object", properties: {}, additionalProperties: false } },
  },
  methods: {
    history: {
      input: empty,
      output: {
        type: "object",
        properties: {
          hits: { type: "array", items: hit },
          total: { type: "number" },
          limit: { type: "number" },
        },
        required: ["hits", "total", "limit"],
        additionalProperties: false,
      },
    },
    clear: {
      input: empty,
      output: {
        type: "object",
        properties: { cleared: { type: "number" } },
        required: ["cleared"],
        additionalProperties: false,
      },
    },
  },
})

export type ProtectionHistoryResult = {
  readonly hits: ProtectionHit[]
  readonly total: number
  readonly limit: number
}
