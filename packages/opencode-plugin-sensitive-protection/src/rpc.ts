import { Rpc } from "@opencode/plugin/rpc"
import type { ProtectionHit } from "./types.js"

export type { ProtectionHit, ProtectionMatch, ProtectionSource } from "./types.js"

const match = {
  type: "object",
  properties: {
    file: { type: "string" },
    label: { type: "string" },
    source: { type: "string", enum: ["manual", "default", "config"] },
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
    source: { type: "string", enum: ["manual", "default", "config"] },
    format: { type: "string" },
    keys: { type: "array", items: { type: "string" } },
    keyCount: { type: "number" },
    label: { type: "string" },
    role: { type: "string" },
    keyID: { type: "string" },
    createdAt: { type: "number" },
    invalid: { type: "string" },
    project: { type: "string" },
    projects: { type: "array", items: { type: "string" } },
    disabled: { type: "boolean" },
    pending: { type: "boolean" },
  },
  required: ["path", "source", "keys", "keyCount", "createdAt"],
  additionalProperties: false,
} as const

const request = {
  type: "object",
  properties: {
    id: { type: "string" },
    path: { type: "string" },
    source: { type: "string", enum: ["manual", "default", "config"] },
    project: { type: "string" },
    sessionID: { type: "string" },
    reason: { type: "string" },
    createdAt: { type: "number" },
  },
  required: ["id", "path", "source", "createdAt"],
  additionalProperties: false,
} as const

export const ProtectionRpc = Rpc.define({
  id: "max10240.sensitive-protection",
  events: {
    hit: { schema: hit },
    cleared: { schema: { type: "object", properties: {}, additionalProperties: false } },
    files: { schema: { type: "object", properties: { count: { type: "number" } }, required: ["count"], additionalProperties: false } },
    pending: { schema: { type: "object", properties: { count: { type: "number" } }, required: ["count"], additionalProperties: false } },
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
    unprotect: {
      input: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: {
          removed: { type: "boolean" },
          disabled: { type: "boolean" },
        },
        required: ["removed", "disabled"],
        additionalProperties: false,
      },
    },
    restore: {
      input: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: { restored: { type: "boolean" } },
        required: ["restored"],
        additionalProperties: false,
      },
    },
    pending: {
      input: empty,
      output: {
        type: "object",
        properties: {
          requests: { type: "array", items: request },
          count: { type: "number" },
        },
        required: ["requests", "count"],
        additionalProperties: false,
      },
    },
    resolve: {
      input: {
        type: "object",
        properties: {
          id: { type: "string" },
          approve: { type: "boolean" },
        },
        required: ["id", "approve"],
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: { resolved: { type: "boolean" } },
        required: ["resolved"],
        additionalProperties: false,
      },
    },
  },
})

export type ProtectionFileInfo = {
  readonly path: string
  readonly source: "manual" | "default" | "config"
  readonly format?: string
  readonly keys: readonly string[]
  readonly keyCount: number
  readonly label?: string
  readonly role?: string
  readonly keyID?: string
  readonly createdAt: number
  readonly invalid?: string
  readonly project?: string
  readonly projects?: readonly string[]
  readonly disabled?: boolean
  readonly pending?: boolean
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

export type ProtectionRequest = {
  readonly id: string
  readonly path: string
  readonly source: "manual" | "default" | "config"
  readonly project?: string
  readonly sessionID?: string
  readonly reason?: string
  readonly createdAt: number
}

export type ProtectionPendingResult = {
  readonly requests: ProtectionRequest[]
  readonly count: number
}
