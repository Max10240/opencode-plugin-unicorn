import type { Context } from "@opencode/plugin/promise/plugin"
import type { Result as ToolResult } from "@opencode/plugin/promise/tool"
import { acquireSessionDirectory, listOnlineSessions, listOnlineSessionsAcrossContexts } from "./session-directory.js"

const SEND_TOOL = "send_message_across_sessions"
const LIST_TOOL = "list_online_sessions"

export const MESSAGE_PREFIX = "Message from"
export const SEND_TOOL_DESCRIPTION =
  "Send a user message to another online OpenCode session. Use only for cross-session messaging; never between a main agent and its subagents."

type SendMessageInput = {
  readonly target_session_id?: string
  readonly message: string
  readonly "need-reply": boolean
  readonly delivery?: "steer" | "queue"
}

export const REPLY_REQUEST = "\n---\nThe above session needs your reply."

type PluginContext = Pick<Context, "event" | "session" | "storage" | "tool">
type SessionPromptInput = Parameters<Context["session"]["prompt"]>[0]

export async function setupSendMessageAcrossSessions(context: PluginContext) {
  const releaseDirectory = acquireSessionDirectory(context)
  try {
    const registration = await context.tool.transform((editor) => {
      editor.add({
        name: SEND_TOOL,
        options: { codemode: false },
        description: SEND_TOOL_DESCRIPTION,
        input: {
          type: "object",
          properties: {
            target_session_id: {
              type: "string",
              description: "Target session ID; omit to list available sessions.",
            },
            message: {
              type: "string",
              description: "Message to send.",
              minLength: 1,
            },
            "need-reply": {
              type: "boolean",
              description: "Whether the target session should reply.",
            },
            delivery: {
              type: "string",
              enum: ["steer", "queue"],
              description:
                '"steer" (default) delivers immediately. "queue" waits until the target is fully idle; this can take a long time and the message may be stale, so use it only for non-urgent messages.',
            },
          },
          required: ["message", "need-reply"],
          additionalProperties: false,
        },
        execute: async (rawInput, tool) => {
          const input = rawInput as SendMessageInput
          const available = await listOnlineSessionsAcrossContexts(context, tool.sessionID)
          if (!input.target_session_id) return selectionResult(available)

          if (input.target_session_id === tool.sessionID)
            return { content: "Cannot send a cross-session message to the current session.", metadata: { sent: false } }

          const target = available.find((session) => session.id === input.target_session_id)

          const text = `${MESSAGE_PREFIX} <${tool.sessionID}>: ${input.message}${input["need-reply"] === true ? REPLY_REQUEST : ""}`
          const delivery = input.delivery === "queue" ? "queue" : "steer"
          try {
            await context.session.prompt({
              sessionID: input.target_session_id as SessionPromptInput["sessionID"],
              text,
              delivery,
            })
          } catch (error) {
            return {
              content: `Message delivery failed; target session ${input.target_session_id} is unavailable.`,
              metadata: { sent: false, error: error instanceof Error ? error.message : String(error) },
            }
          }
          return {
            content: `Message sent to ${input.target_session_id}${target?.title ? ` (${target.title})` : ""}.`,
            metadata: { sent: true, target_session_id: input.target_session_id, delivery, text },
          }
        },
      })

      editor.add({
        name: LIST_TOOL,
        options: { codemode: false },
        description: "List other online OpenCode sessions across working directories.",
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
      content: "No other online OpenCode sessions were found. Make sure the target session has started.",
      metadata: { sessions: [] },
    }
  }
  return {
    content: `Choose a target session, then call ${SEND_TOOL} again with target_session_id:\n\n${formatSessions(sessions)}`,
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
