import { Rpc } from "@opencode/plugin/rpc"
import type { DelayedQueueBackground, DelayedQueueItem, DelayedQueueJob, DelayedQueueStatus, PauseReason } from "./controller.js"

const sessionInput = {
  type: "object",
  properties: { sessionID: { type: "string" } },
  required: ["sessionID"],
  additionalProperties: false,
} as const

const item = {
  type: "object",
  properties: {
    id: { type: "string" },
    text: { type: "string" },
    createdAt: { type: "number" },
  },
  required: ["id", "text", "createdAt"],
  additionalProperties: false,
} as const

const background = {
  type: "object",
  properties: {
    kind: { type: "string" },
    sessionID: { type: "string" },
    label: { type: "string" },
    jobID: { type: "string" },
    shellID: { type: "string" },
    command: { type: "string" },
    childSessionID: { type: "string" },
    agent: { type: "string" },
    description: { type: "string" },
    path: { type: "string" },
    model: { type: "string" },
  },
  required: ["kind", "sessionID"],
  additionalProperties: false,
} as const

const job = {
  type: "object",
  properties: {
    id: { type: "string" },
    kind: { type: "string" },
    sessionID: { type: "string" },
    status: { type: "string" },
    childSessionID: { type: "string" },
    shellID: { type: "string" },
    command: { type: "string" },
    description: { type: "string" },
    title: { type: "string" },
    path: { type: "string" },
  },
  required: ["id", "kind", "sessionID", "status"],
  additionalProperties: false,
} as const

const status = {
  type: "object",
  properties: {
    sessionID: { type: "string" },
    paused: { type: "boolean" },
    pauseReason: { type: "string", enum: ["interrupted", "failed", "restart", "manual", "delivery"] },
    items: { type: "array", items: item },
    waitingFor: { type: "array", items: background },
    observed: { type: "boolean" },
    delivering: { type: "boolean" },
    lastError: { type: "string" },
    updatedAt: { type: "number" },
  },
  required: ["sessionID", "paused", "items", "waitingFor", "observed", "delivering", "updatedAt"],
  additionalProperties: false,
} as const

const invalid = { type: "object", additionalProperties: false } as const

export const DelayedQueueRpc = Rpc.define({
  id: "max10240.delayed-queue",
  events: {
    changed: {
      schema: {
        type: "object",
        properties: {
          sessionID: { type: "string" },
          state: status,
        },
        required: ["sessionID", "state"],
        additionalProperties: false,
      },
    },
  },
  methods: {
    status: {
      input: sessionInput,
      output: status,
      errors: { invalid },
    },
    enqueue: {
      input: {
        type: "object",
        properties: {
          sessionID: { type: "string" },
          text: { type: "string" },
          jobs: { type: "array", items: job },
        },
        required: ["sessionID", "text"],
        additionalProperties: false,
      },
      output: status,
      errors: { invalid },
    },
    syncJobs: {
      input: {
        type: "object",
        properties: {
          sessionID: { type: "string" },
          jobs: { type: "array", items: job },
        },
        required: ["sessionID", "jobs"],
        additionalProperties: false,
      },
      output: status,
      errors: { invalid },
    },
    remove: {
      input: {
        type: "object",
        properties: {
          sessionID: { type: "string" },
          ids: { type: "array", items: { type: "string" } },
        },
        required: ["sessionID", "ids"],
        additionalProperties: false,
      },
      output: status,
      errors: { invalid },
    },
    clear: {
      input: sessionInput,
      output: status,
      errors: { invalid },
    },
    pause: {
      input: sessionInput,
      output: status,
      errors: { invalid },
    },
    resume: {
      input: sessionInput,
      output: status,
      errors: { invalid },
    },
    deliver: {
      input: {
        type: "object",
        properties: {
          sessionID: { type: "string" },
          id: { type: "string" },
        },
        required: ["sessionID", "id"],
        additionalProperties: false,
      },
      output: status,
      errors: { invalid },
    },
  },
})

export type DelayedQueueStatusPayload = DelayedQueueStatus

/** Narrows controller values to the exact RPC payload shape (no extra keys). */
export function toStatusPayload(status: DelayedQueueStatus): DelayedQueueStatusPayload {
  return {
    sessionID: status.sessionID,
    paused: status.paused,
    ...(status.pauseReason === undefined ? {} : { pauseReason: status.pauseReason }),
    items: status.items.map((entry: DelayedQueueItem) => ({
      id: entry.id,
      text: entry.text,
      createdAt: entry.createdAt,
    })),
    waitingFor: status.waitingFor.map((work: DelayedQueueBackground) => ({
      kind: work.kind,
      sessionID: work.sessionID,
      ...(work.label === undefined ? {} : { label: work.label }),
      ...(work.jobID === undefined ? {} : { jobID: work.jobID }),
      ...(work.shellID === undefined ? {} : { shellID: work.shellID }),
      ...(work.command === undefined ? {} : { command: work.command }),
      ...(work.childSessionID === undefined ? {} : { childSessionID: work.childSessionID }),
      ...(work.agent === undefined ? {} : { agent: work.agent }),
      ...(work.description === undefined ? {} : { description: work.description }),
      ...(work.path === undefined ? {} : { path: work.path }),
      ...(work.model === undefined ? {} : { model: work.model }),
    })),
    observed: status.observed,
    delivering: status.delivering,
    ...(status.lastError === undefined ? {} : { lastError: status.lastError }),
    updatedAt: status.updatedAt,
  }
}

export function toJobPayload(job: DelayedQueueJob): DelayedQueueJob {
  return {
    id: job.id,
    kind: job.kind,
    sessionID: job.sessionID,
    status: job.status,
    ...(job.childSessionID === undefined ? {} : { childSessionID: job.childSessionID }),
    ...(job.shellID === undefined ? {} : { shellID: job.shellID }),
    ...(job.command === undefined ? {} : { command: job.command }),
    ...(job.description === undefined ? {} : { description: job.description }),
    ...(job.title === undefined ? {} : { title: job.title }),
    ...(job.path === undefined ? {} : { path: job.path }),
  }
}

export type { PauseReason }
