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
    cooldownMs: { type: "number" },
    cooldownUntil: { type: "number" },
    nextNudgeAt: { type: "number" },
    phase: { type: "string", enum: ["waiting", "quiet", "checking", "paused"] },
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

const listItem = {
  type: "object",
  properties: {
    sessionID: { type: "string" },
    title: { type: "string" },
    directory: { type: "string" },
    ...state.properties,
  },
  required: ["sessionID", "active"],
  additionalProperties: false,
} as const

const sessionInput = {
  type: "object",
  properties: { sessionID: { type: "string" } },
  required: ["sessionID"],
  additionalProperties: false,
} as const

const emptyInput = { type: "object", properties: {}, required: [], additionalProperties: false } as const
const invalid = { type: "object", additionalProperties: false } as const

export const InfiniteLoopRpc = Rpc.define({
  id: "max10240.infinite-loop",
  events: {},
  methods: {
    status: {
      input: sessionInput,
      output: state,
      errors: { invalid },
    },
    list: {
      input: emptyInput,
      output: { type: "array", items: listItem },
      errors: { invalid },
    },
    start: {
      input: {
        type: "object",
        properties: {
          sessionID: { type: "string" },
          durationMs: { type: "number" },
          cooldownMs: { type: "number" },
        },
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

export type InfiniteLoopStatusPayload = {
  active: boolean
  startedAt?: number
  deadline?: number
  sentCount?: number
  lastSentAt?: number
  lastInputAt?: number
  cooldownMs?: number
  cooldownUntil?: number
  nextNudgeAt?: number
  phase?: "waiting" | "quiet" | "checking" | "paused"
  nudging?: boolean
  outcome?: { reason: "expired" | "stopped"; at: number; sentCount?: number; lastSentAt?: number }
}

export type InfiniteLoopListItem = InfiniteLoopStatusPayload & {
  sessionID: string
  title?: string
  directory?: string
}

/** Narrows a controller status to the exact RPC payload shape (no extra keys). */
export function toStatusPayload(status: {
  active: boolean
  startedAt?: number
  deadline?: number
  sentCount?: number
  lastSentAt?: number
  lastInputAt?: number
  cooldownMs?: number
  cooldownUntil?: number
  nextNudgeAt?: number
  phase?: "waiting" | "quiet" | "checking" | "paused"
  nudging?: boolean
  outcome?: { reason: "expired" | "stopped"; at: number; sentCount?: number; lastSentAt?: number }
}): InfiniteLoopStatusPayload {
  return {
    active: status.active,
    ...(status.startedAt === undefined ? {} : { startedAt: status.startedAt }),
    ...(status.deadline === undefined ? {} : { deadline: status.deadline }),
    ...(status.sentCount === undefined ? {} : { sentCount: status.sentCount }),
    ...(status.lastSentAt === undefined ? {} : { lastSentAt: status.lastSentAt }),
    ...(status.lastInputAt === undefined ? {} : { lastInputAt: status.lastInputAt }),
    ...(status.cooldownMs === undefined ? {} : { cooldownMs: status.cooldownMs }),
    ...(status.cooldownUntil === undefined ? {} : { cooldownUntil: status.cooldownUntil }),
    ...(status.nextNudgeAt === undefined ? {} : { nextNudgeAt: status.nextNudgeAt }),
    ...(status.phase === undefined ? {} : { phase: status.phase }),
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

export function toListItem(
  sessionID: string,
  status: Parameters<typeof toStatusPayload>[0],
  info: { title?: string; directory?: string } = {},
): InfiniteLoopListItem {
  return {
    sessionID,
    ...(info.title === undefined ? {} : { title: info.title }),
    ...(info.directory === undefined ? {} : { directory: info.directory }),
    ...toStatusPayload(status),
  }
}
