import { expect, test } from "bun:test"
import type { Context } from "@opencode/plugin/promise/plugin"
import type { Info, ToolContext, ToolEditor } from "@opencode/plugin/promise/tool"
import { MESSAGE_PREFIX, SEND_TOOL_DESCRIPTION, setupSendMessageAcrossSessions } from "../src/setup.js"
import { listOnlineSessionsAcrossContexts } from "../src/session-directory.js"

const TARGET_ID = "ses_target"
const SENDER_ID = "ses_sender"

const targetRecord = {
  id: TARGET_ID,
  title: "target",
  directory: "/tmp/target",
  status: "idle" as const,
  createdAt: 1,
  updatedAt: 2,
}

async function setup(prompt: (input: Record<string, unknown>) => Promise<void>, scan?: () => Promise<any>) {
  const registered = new Map<string, Info>()
  const context = {
    event: { subscribe: async function* () {} },
    session: { prompt },
    storage: {
      scan: scan ?? (async () => ({ entries: [{ key: `online-sessions/${TARGET_ID}`, value: targetRecord }] })),
      set: async () => {},
      remove: async () => {},
    },
    tool: {
      transform: async (callback: (editor: ToolEditor) => void) => {
        callback({ add: (tool: Info) => registered.set(tool.name, tool) } as unknown as ToolEditor)
        return { dispose: async () => {} }
      },
    },
  } as unknown as Parameters<typeof setupSendMessageAcrossSessions>[0]
  const cleanup = await setupSendMessageAcrossSessions(context)
  return { registered, cleanup }
}

function send(registered: Map<string, Info>, input: Record<string, unknown>) {
  const tool = registered.get("send_message_across_sessions")!
  return tool.execute(input, { sessionID: SENDER_ID, progress: async () => {} } as unknown as ToolContext) as Promise<any>
}

test("uses steer delivery by default and supports an explicit queue", async () => {
  const prompts: Array<Record<string, unknown>> = []
  const { registered, cleanup } = await setup(async (input) => {
    prompts.push(input)
  })
  try {
    const sendTool = registered.get("send_message_across_sessions")!
    expect(sendTool.description).toBe(SEND_TOOL_DESCRIPTION)
    expect(sendTool.description).toContain("cross-session")
    expect(sendTool.description).toContain("subagents")

    const schema = sendTool.input as any
    expect(schema.properties.delivery).toMatchObject({ type: "string", enum: ["steer", "queue"] })
    expect(schema.properties.delivery.description).toContain('"steer" (default)')
    expect(schema.properties.target_session_id.description).toContain("omit")
    expect(schema.properties["need-reply"]).toMatchObject({ type: "boolean", description: "Whether the target session should reply." })
    expect(schema.required).toEqual(["message", "need-reply"])
    expect(schema.additionalProperties).toBe(false)

    const defaultResult = await send(registered, { target_session_id: TARGET_ID, message: "default", "need-reply": false })
    expect(prompts[0]).toMatchObject({ sessionID: TARGET_ID, delivery: "steer" })
    expect(prompts[0]?.text).toBe(`${MESSAGE_PREFIX} <${SENDER_ID}>: default`)
    expect(defaultResult.metadata).toMatchObject({ sent: true, delivery: "steer" })

    await send(registered, { target_session_id: TARGET_ID, message: "queued", "need-reply": true, delivery: "queue" })
    expect(prompts[1]).toMatchObject({ sessionID: TARGET_ID, delivery: "queue" })
    expect(prompts[1]?.text).toBe(`${MESSAGE_PREFIX} <${SENDER_ID}>: queued\n---\nThe above session needs your reply.`)
  } finally {
    await cleanup()
  }
})

test("reports a failed send without claiming the message was delivered", async () => {
  const { registered, cleanup } = await setup(async () => {
    throw new Error("target offline")
  })
  try {
    const result = await send(registered, { target_session_id: TARGET_ID, message: "hello", "need-reply": false })
    expect(result.content).toContain("Message delivery failed")
    expect(result.metadata).toMatchObject({ sent: false, error: "target offline" })
  } finally {
    await cleanup()
  }
})

test("rejects sending to the current session", async () => {
  const prompts: Array<Record<string, unknown>> = []
  const { registered, cleanup } = await setup(async (input) => {
    prompts.push(input)
  })
  try {
    const result = await send(registered, { target_session_id: SENDER_ID, message: "hello", "need-reply": false })
    expect(result.metadata).toMatchObject({ sent: false })
    expect(prompts).toHaveLength(0)
  } finally {
    await cleanup()
  }
})

test("paginates the listed sessions and reports the total", async () => {
  const entries = Array.from({ length: 60 }, (_, index) => ({
    key: `online-sessions/ses_${index}`,
    value: { ...targetRecord, id: `ses_${index}`, title: `session ${index}`, updatedAt: index },
  }))
  const { registered, cleanup } = await setup(async () => {}, async () => ({ entries }))
  try {
    const list = registered.get("list_online_sessions")!
    const first = await list.execute({}, { sessionID: SENDER_ID } as ToolContext) as any
    expect(first.metadata.total).toBe(60)
    expect(first.metadata.offset).toBe(0)
    expect(first.metadata.next).toBe(50)
    expect(first.metadata.sessions).toHaveLength(50)
    expect(first.content).toContain("Showing 1-50 of 60.")
    expect(first.content).toContain("offset=50")

    const second = await list.execute({ offset: 50 }, { sessionID: SENDER_ID } as ToolContext) as any
    expect(second.metadata.total).toBe(60)
    expect(second.metadata.offset).toBe(50)
    expect(second.metadata.next).toBeNull()
    expect(second.metadata.sessions).toHaveLength(10)
    expect(second.content).toContain("Showing 51-60 of 60.")
  } finally {
    await cleanup()
  }
})

test("does not hang when storage scan stalls or repeats pagination", async () => {
  const stalled = {
    storage: { scan: () => new Promise(() => {}) },
  }
  const started = Date.now()
  const empty = await listOnlineSessionsAcrossContexts(stalled as never, undefined, 30)
  expect(Date.now() - started).toBeLessThan(1_000)
  expect(Array.isArray(empty)).toBe(true)

  let calls = 0
  const repeated = {
    storage: {
      scan: async () => {
        calls++
        return { entries: [{ key: "online-sessions/repeated", value: targetRecord }], next: "same" }
      },
    },
  }
  const listed = await listOnlineSessionsAcrossContexts(repeated as never, undefined, 100)
  expect(calls).toBeLessThanOrEqual(2)
  expect(listed.map((session) => session.id)).toContain(TARGET_ID)
})

test("uses session.list as the authoritative source and prunes stale storage", async () => {
  const live = {
    id: "ses_live",
    title: "Live",
    location: { directory: "/live" },
    time: { created: 1, updated: 10, busy: 9, idle: 8 },
  }
  const liveRecord = {
    id: "ses_live",
    title: "Live",
    directory: "/live",
    status: "idle" as const,
    createdAt: 1,
    updatedAt: 10,
  }
  const deadRecord = { ...targetRecord, id: "ses_dead", title: "Dead" }
  const removed: string[] = []
  const context = {
    session: { list: async () => ({ data: [live], cursor: {} }) },
    storage: {
      scan: async () => ({
        entries: [
          { key: "online-sessions/ses_live", value: liveRecord },
          { key: "online-sessions/ses_dead", value: deadRecord },
        ],
      }),
      remove: async (key: string) => { removed.push(key) },
    },
  }
  const listed = await listOnlineSessionsAcrossContexts(context as never, undefined, 100)
  expect(listed.map((session) => session.id)).toEqual(["ses_live"])
  expect(listed[0]?.status).toBe("running")
  await Bun.sleep(30)
  expect(removed).toContain("online-sessions/ses_dead")
})
