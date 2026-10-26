import { expect, test } from "bun:test"
import type { Context } from "@opencode/plugin/promise/plugin"
import type { Info, ToolContext, ToolEditor } from "@opencode/plugin/promise/tool"
import { MESSAGE_PREFIX, SEND_TOOL_DESCRIPTION, setupSendMessageAcrossSessions } from "../src/setup.js"

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

async function setup(prompt: (input: Record<string, unknown>) => Promise<void>) {
  const registered = new Map<string, Info>()
  const context = {
    event: { subscribe: async function* () {} },
    session: { prompt },
    storage: {
      scan: async () => ({ entries: [{ key: `online-sessions/${TARGET_ID}`, value: targetRecord }] }),
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
    expect(schema.required).toEqual(["message"])
    expect(schema.additionalProperties).toBe(false)

    const defaultResult = await send(registered, { target_session_id: TARGET_ID, message: "default" })
    expect(prompts[0]).toMatchObject({ sessionID: TARGET_ID, delivery: "steer" })
    expect(prompts[0]?.text).toBe(`${MESSAGE_PREFIX}<${SENDER_ID}>的消息: default`)
    expect(defaultResult.metadata).toMatchObject({ sent: true, delivery: "steer" })

    await send(registered, { target_session_id: TARGET_ID, message: "queued", delivery: "queue" })
    expect(prompts[1]).toMatchObject({ sessionID: TARGET_ID, delivery: "queue" })
  } finally {
    await cleanup()
  }
})

test("reports a failed send without claiming the message was delivered", async () => {
  const { registered, cleanup } = await setup(async () => {
    throw new Error("target offline")
  })
  try {
    const result = await send(registered, { target_session_id: TARGET_ID, message: "hello" })
    expect(result.content).toContain("消息发送失败")
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
    const result = await send(registered, { target_session_id: SENDER_ID, message: "hello" })
    expect(result.metadata).toMatchObject({ sent: false })
    expect(prompts).toHaveLength(0)
  } finally {
    await cleanup()
  }
})
