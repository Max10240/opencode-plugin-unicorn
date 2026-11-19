import { Rpc } from "@opencode/plugin/rpc"

const note = {
  type: "object",
  properties: {
    id: { type: "string" },
    text: { type: "string" },
    scope: { type: "string", enum: ["folder", "global"] },
    folder: { type: "string" },
    pinned: { type: "boolean" },
    createdAt: { type: "number" },
    updatedAt: { type: "number" },
  },
  required: ["id", "text", "scope", "createdAt", "updatedAt"],
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
        properties: { directory: { type: "string" } },
        required: ["directory"],
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: { notes: { type: "array", items: note } },
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
          scope: { type: "string", enum: ["folder", "global"] },
          directory: { type: "string" },
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
      output: { type: "object", properties: { note }, required: ["note"], additionalProperties: false },
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
    setScope: {
      input: {
        type: "object",
        properties: {
          id: { type: "string" },
          scope: { type: "string", enum: ["folder", "global"] },
          directory: { type: "string" },
        },
        required: ["id", "scope", "directory"],
        additionalProperties: false,
      },
      output: { type: "object", properties: { note }, required: ["note"], additionalProperties: false },
      errors: { invalid },
    },
  },
})
