import { Rpc } from "@opencode/plugin/rpc"

const note = {
  type: "object",
  properties: {
    id: { type: "string" },
    text: { type: "string" },
    scope: { type: "string", enum: ["session", "folder", "global"] },
    folder: { type: "string" },
    session: { type: "string" },
    pinned: { type: "boolean" },
    createdAt: { type: "number" },
    updatedAt: { type: "number" },
  },
  required: ["id", "text", "scope", "createdAt", "updatedAt"],
  additionalProperties: false,
} as const

const goal = {
  type: "object",
  properties: {
    noteID: { type: "string" },
    text: { type: "string" },
    scope: { type: "string", enum: ["session", "folder"] },
    folder: { type: "string" },
    session: { type: "string" },
    updatedAt: { type: "number" },
  },
  required: ["noteID", "text", "scope", "updatedAt"],
  additionalProperties: false,
} as const

const invalid = { type: "object", additionalProperties: false } as const

export const NotepadRpc = Rpc.define({
  id: "max10240.notepad",
  events: {},
  methods: {
    list: {
      input: {
        type: "object",
        properties: { directory: { type: "string" }, session: { type: "string" } },
        required: ["directory"],
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: {
          notes: { type: "array", items: note },
          goal,
        },
        required: ["notes"],
        additionalProperties: false,
      },
      errors: { invalid },
    },
    add: {
      input: {
        type: "object",
        properties: {
          text: { type: "string" },
          scope: { type: "string", enum: ["session", "folder", "global"] },
          directory: { type: "string" },
          session: { type: "string" },
          pinned: { type: "boolean" },
        },
        required: ["text", "scope", "directory"],
        additionalProperties: false,
      },
      output: { type: "object", properties: { note }, required: ["note"], additionalProperties: false },
      errors: { invalid },
    },
    update: {
      input: {
        type: "object",
        properties: { id: { type: "string" }, text: { type: "string" } },
        required: ["id", "text"],
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: { note, goalCleared: { type: "boolean" } },
        required: ["note"],
        additionalProperties: false,
      },
      errors: { invalid },
    },
    remove: {
      input: {
        type: "object",
        properties: { id: { type: "string" } },
        required: ["id"],
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: { removed: { type: "boolean" } },
        required: ["removed"],
        additionalProperties: false,
      },
      errors: { invalid },
    },
    setPinned: {
      input: {
        type: "object",
        properties: { id: { type: "string" }, pinned: { type: "boolean" } },
        required: ["id", "pinned"],
        additionalProperties: false,
      },
      output: { type: "object", properties: { note }, required: ["note"], additionalProperties: false },
      errors: { invalid },
    },
    setGoal: {
      input: {
        type: "object",
        properties: {
          sessionID: { type: "string" },
          noteID: { type: "string" },
          directory: { type: "string" },
        },
        required: ["sessionID", "noteID", "directory"],
        additionalProperties: false,
      },
      output: { type: "object", properties: { goal }, required: ["goal"], additionalProperties: false },
      errors: { invalid },
    },
    clearGoal: {
      input: {
        type: "object",
        properties: { sessionID: { type: "string" } },
        required: ["sessionID"],
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: { cleared: { type: "boolean" } },
        required: ["cleared"],
        additionalProperties: false,
      },
      errors: { invalid },
    },
  },
})
