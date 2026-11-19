import { Rpc } from "@opencode/plugin/rpc"

const state = {
  type: "object",
  properties: {
    active: { type: "boolean" },
    startedAt: { type: "number" },
    deadline: { type: "number" },
    sentCount: { type: "number" },
    lastSentAt: { type: "number" },
    lastInputAt: { type: "number" },
    nudging: { type: "boolean" },
    outcome: {
      type: "object",
      properties: {
        reason: { type: "string", enum: ["expired", "stopped"] },
        at: { type: "number" },
        sentCount: { type: "number" },
        lastSentAt: { type: "number" },
      },
      required: ["reason", "at"],
      additionalProperties: false,
    },
  },
  required: ["active"],
  additionalProperties: false,
} as const

const sessionInput = {
  type: "object",
  properties: { sessionID: { type: "string" } },
  required: ["sessionID"],
  additionalProperties: false,
} as const

const invalid = { type: "object", additionalProperties: false } as const

export const DeadLoopRpc = Rpc.define({
  id: "max10240.dead-loop",
  events: {},
  methods: {
    status: {
      input: sessionInput,
      output: state,
      errors: { invalid },
    },
    start: {
      input: {
        type: "object",
        properties: { sessionID: { type: "string" }, durationMs: { type: "number" } },
        required: ["sessionID", "durationMs"],
        additionalProperties: false,
      },
      output: state,
      errors: { invalid },
    },
    stop: {
      input: sessionInput,
      output: state,
      errors: { invalid },
    },
  },
})

export type DeadLoopStatusPayload = {
  active: boolean
  startedAt?: number
  deadline?: number
  sentCount?: number
  lastSentAt?: number
  lastInputAt?: number
  nudging?: boolean
  outcome?: { reason: "expired" | "stopped"; at: number; sentCount?: number; lastSentAt?: number }
}

/** Narrows a controller status to the exact RPC payload shape (no extra keys). */
export function toStatusPayload(status: {
  active: boolean
  startedAt?: number
  deadline?: number
  sentCount?: number
  lastSentAt?: number
  lastInputAt?: number
  nudging?: boolean
  outcome?: { reason: "expired" | "stopped"; at: number; sentCount?: number; lastSentAt?: number }
}): DeadLoopStatusPayload {
  return {
    active: status.active,
    ...(status.startedAt === undefined ? {} : { startedAt: status.startedAt }),
    ...(status.deadline === undefined ? {} : { deadline: status.deadline }),
    ...(status.sentCount === undefined ? {} : { sentCount: status.sentCount }),
    ...(status.lastSentAt === undefined ? {} : { lastSentAt: status.lastSentAt }),
    ...(status.lastInputAt === undefined ? {} : { lastInputAt: status.lastInputAt }),
    ...(status.nudging === undefined ? {} : { nudging: status.nudging }),
    ...(status.outcome === undefined
      ? {}
      : {
          outcome: {
            reason: status.outcome.reason,
            at: status.outcome.at,
            ...(status.outcome.sentCount === undefined ? {} : { sentCount: status.outcome.sentCount }),
            ...(status.outcome.lastSentAt === undefined ? {} : { lastSentAt: status.outcome.lastSentAt }),
          },
        }),
  }
}
