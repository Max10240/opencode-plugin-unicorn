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

const file = {
  type: "object",
  properties: {
    path: { type: "string" },
    role: { type: "string" },
    keyID: { type: "string" },
    label: { type: "string" },
    createdAt: { type: "number" },
    read: { type: "string", enum: ["redact", "block"] },
    write: { type: "string", enum: ["block", "allow"] },
    source: { type: "string", enum: ["manual", "builtin", "custom"] },
    keys: { type: "array", items: { type: "string" } },
    keyCount: { type: "number" },
  },
  required: ["path", "role", "createdAt", "read", "write", "source", "keys", "keyCount"],
  additionalProperties: false,
} as const

export const ProtectionRpc = Rpc.define({
  id: "max10240.sensitive-protection",
  events: {
    hit: { schema: hit },
    cleared: { schema: { type: "object", properties: {}, additionalProperties: false } },
    files: { schema: { type: "object", properties: { count: { type: "number" } }, required: ["count"], additionalProperties: false } },
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
    files: {
      input: empty,
      output: {
        type: "object",
        properties: {
          files: { type: "array", items: file },
          total: { type: "number" },
          refreshedAt: { type: "number" },
        },
        required: ["files", "total", "refreshedAt"],
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

export type ProtectionFileInfo = {
  readonly path: string
  readonly role: string
  readonly keyID?: string
  readonly label?: string
  readonly createdAt: number
  readonly read: "redact" | "block"
  readonly write: "block" | "allow"
  readonly source: "manual" | "builtin" | "custom"
  readonly keys: readonly string[]
  readonly keyCount: number
}

export type ProtectionFilesResult = {
  readonly files: ProtectionFileInfo[]
  readonly total: number
  readonly refreshedAt: number
}

export type ProtectionHistoryResult = {
  readonly hits: ProtectionHit[]
  readonly total: number
  readonly limit: number
}
