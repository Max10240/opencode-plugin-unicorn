import type { Context } from "@opencode/plugin/promise/plugin"
import type { Result as ToolResult } from "@opencode/plugin/promise/tool"
import { acquireSessionDirectory, listOnlineSessions, listOnlineSessionsAcrossContexts } from "./session-directory.js"

const SEND_TOOL = "send_message_across_sessions"
const LIST_TOOL = "list_online_sessions"
const DEFAULT_LIST_LIMIT = 20
const MAX_LIST_LIMIT = 100
const MAX_CONTENT_BYTES = 16 * 1024
const MAX_TITLE_LENGTH = 80
const MAX_DIRECTORY_LENGTH = 120

export const MESSAGE_PREFIX = "Message from"
export const SEND_TOOL_DESCRIPTION =
  "Send a user message to another online OpenCode session. Use only for cross-session messaging; never between a main agent and its subagents."

type SendMessageInput = {
  readonly target_session_id?: string
  readonly message: string
  readonly need_reply: boolean
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
            need_reply: {
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
          required: ["message", "need_reply"],
          additionalProperties: false,
        },
        execute: async (rawInput, tool) => {
          const input = rawInput as SendMessageInput
          const available = await listOnlineSessionsAcrossContexts(context, tool.sessionID)
          if (!input.target_session_id) return selectionResult(available)

          if (input.target_session_id === tool.sessionID)
            return { content: "Cannot send a cross-session message to the current session.", metadata: { sent: false } }

          const target = available.find((session) => session.id === input.target_session_id)

          const text = `${MESSAGE_PREFIX} <${tool.sessionID}>: ${input.message}${input.need_reply === true ? REPLY_REQUEST : ""}`
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
          properties: {
            limit: {
              type: "integer",
              minimum: 1,
              maximum: MAX_LIST_LIMIT,
              description: "Maximum sessions to return (default 20).",
            },
            offset: {
              type: "integer",
              minimum: 0,
              description: "Number of sessions to skip for pagination.",
            },
          },
          required: [],
          additionalProperties: false,
        },
        execute: async (rawInput, tool) => {
          try {
            return selectionResult(
              await listOnlineSessionsAcrossContexts(context, tool.sessionID),
              listPage(rawInput),
            )
          } catch (error) {
            return {
              content: `Unable to list online sessions: ${error instanceof Error ? error.message : String(error)}`,
              metadata: { sessions: [], error: error instanceof Error ? error.message : String(error) },
            }
          }
        },
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

function selectionResult(
  sessions: ReturnType<typeof listOnlineSessions>,
  page: { readonly limit: number; readonly offset: number } = { limit: DEFAULT_LIST_LIMIT, offset: 0 },
): ToolResult {
  if (sessions.length === 0) {
    return {
      content: "No other online OpenCode sessions were found. Make sure the target session has started.",
      metadata: { sessions: [], total: 0, offset: 0, next: null },
    }
  }
  const listed = sessions.slice(page.offset, page.offset + page.limit).map(compactSession)
  const end = page.offset + listed.length
  const next = end < sessions.length ? end : null
  if (listed.length === 0) {
    return {
      content: `No sessions at offset ${page.offset}; total is ${sessions.length}. Use list_online_sessions with offset=0.`,
      metadata: { sessions: [], total: sessions.length, offset: page.offset, next: 0 },
    }
  }
  const more = next !== null
    ? `\n\nShowing ${page.offset + 1}-${end} of ${sessions.length}. Use list_online_sessions with offset=${next} to see more.`
    : `\n\nShowing ${page.offset + 1}-${end} of ${sessions.length}.`
  const content = limitBytes(
    `Choose a target session, then call ${SEND_TOOL} again with target_session_id:\n\n${formatSessions(listed, page.offset)}${more}`,
    MAX_CONTENT_BYTES,
  )
  return {
    content,
    metadata: { sessions: listed, total: sessions.length, offset: page.offset, next, requires_target_selection: true },
  }
}

function compactSession(session: ReturnType<typeof listOnlineSessions>[number]): ReturnType<typeof listOnlineSessions>[number] {
  return {
    ...session,
    ...(session.title === undefined ? {} : { title: clip(sanitize(session.title), MAX_TITLE_LENGTH) }),
    ...(session.directory === undefined ? {} : { directory: clip(sanitize(session.directory), MAX_DIRECTORY_LENGTH) }),
  }
}

function sanitize(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim()
}

function clip(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`
}

function limitBytes(value: string, max: number): string {
  const bytes = Buffer.from(value, "utf8")
  if (bytes.length <= max) return value
  return `${bytes.subarray(0, max).toString("utf8")}\n[truncated]`
}

function listPage(input: unknown) {
  const value = typeof input === "object" && input !== null ? input as Record<string, unknown> : {}
  const limit = typeof value.limit === "number" && Number.isSafeInteger(value.limit)
    ? Math.min(MAX_LIST_LIMIT, Math.max(1, value.limit))
    : DEFAULT_LIST_LIMIT
  const offset = typeof value.offset === "number" && Number.isSafeInteger(value.offset)
    ? Math.max(0, value.offset)
    : 0
  return { limit, offset }
}

function formatSessions(sessions: readonly ReturnType<typeof listOnlineSessions>[number][], offset = 0) {
  return sessions
    .map((session, index) => {
      const title = session.title ? ` ${session.title}` : ""
      const directory = session.directory ? ` cwd=${session.directory}` : ""
      return `${offset + index + 1}. ${session.id} [${session.status}]${title}${directory}`
    })
    .join("\n")
}
