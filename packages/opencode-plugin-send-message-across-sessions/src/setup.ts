import type { Context } from "@opencode/plugin/promise/plugin"
import type { Result as ToolResult } from "@opencode/plugin/promise/tool"
import { acquireSessionDirectory, listOnlineSessions, listOnlineSessionsAcrossContexts } from "./session-directory.js"

const SEND_TOOL = "send_message_across_sessions"
const LIST_TOOL = "list_online_sessions"

export const MESSAGE_PREFIX = "来自"

type SendMessageInput = {
  readonly target_session_id?: string
  readonly message: string
}

type PluginContext = Pick<Context, "event" | "session" | "storage" | "tool">
type SessionPromptInput = Parameters<Context["session"]["prompt"]>[0]

export async function setupSendMessageAcrossSessions(context: PluginContext) {
  const releaseDirectory = acquireSessionDirectory(context)
  try {
    const registration = await context.tool.transform((editor) => {
      editor.add({
        name: SEND_TOOL,
        options: { codemode: false },
        description:
          "Send a user-style message to another OpenCode session. If target_session_id is omitted, choose one from list_online_sessions first.",
        input: {
          type: "object",
          properties: {
            target_session_id: {
              type: "string",
              description: "The target OpenCode session ID. Omit it to get a selection list.",
            },
            message: {
              type: "string",
              description: "The message to deliver to the target session.",
              minLength: 1,
            },
          },
          required: ["message"],
          additionalProperties: false,
        },
        execute: async (rawInput, tool) => {
          const input = rawInput as SendMessageInput
          const available = await listOnlineSessionsAcrossContexts(context, tool.sessionID)
          if (!input.target_session_id) return selectionResult(available)

          if (input.target_session_id === tool.sessionID)
            return { content: "不能向当前 session 自己发送跨 session 消息。", metadata: { sent: false } }

          const target = available.find((session) => session.id === input.target_session_id)

          const text = `${MESSAGE_PREFIX}<${tool.sessionID}>的消息: ${input.message}`
          try {
            await context.session.prompt({
              sessionID: input.target_session_id as SessionPromptInput["sessionID"],
              text,
              delivery: "queue",
            })
          } catch (error) {
            return {
              content: `消息发送失败，目标 session ${input.target_session_id} 不可用。`,
              metadata: { sent: false, error: error instanceof Error ? error.message : String(error) },
            }
          }
          return {
            content: `消息已发送到 ${input.target_session_id}${target?.title ? `（${target.title}）` : ""}。`,
            metadata: { sent: true, target_session_id: input.target_session_id, text },
          }
        },
      })

      editor.add({
        name: LIST_TOOL,
        options: { codemode: false },
        description: "List online OpenCode sessions from all working directories so the user can choose a target.",
        input: {
          type: "object",
          properties: {},
          required: [],
          additionalProperties: false,
        },
        execute: async (_input, tool) =>
          selectionResult(await listOnlineSessionsAcrossContexts(context, tool.sessionID)),
      })
    })

    return async () => {
      releaseDirectory()
      await registration.dispose()
    }
  } catch (error) {
    releaseDirectory()
    throw error
  }
}

function selectionResult(sessions: ReturnType<typeof listOnlineSessions>): ToolResult {
  if (sessions.length === 0) {
    return {
      content: "当前没有发现其他在线 OpenCode 会话。请确认目标会话已经启动。",
      metadata: { sessions: [] },
    }
  }
  return {
    content: `请选择目标会话，然后再次调用 ${SEND_TOOL} 并传入 target_session_id：\n\n${formatSessions(sessions)}`,
    metadata: { sessions, requires_target_selection: true },
  }
}

function formatSessions(sessions: readonly ReturnType<typeof listOnlineSessions>[number][]) {
  return sessions
    .map((session, index) => {
      const title = session.title ? ` ${session.title}` : ""
      const directory = session.directory ? ` cwd=${session.directory}` : ""
      return `${index + 1}. ${session.id} [${session.status}]${title}${directory}`
    })
    .join("\n")
}
