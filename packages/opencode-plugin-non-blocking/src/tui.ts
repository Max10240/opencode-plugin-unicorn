import { Plugin } from "@opencode/plugin/tui"
import type { Context } from "@opencode/plugin/tui/context"
import {
  NonBlockingController,
  toolKind,
  type SessionSnapshot,
  type ToolSnapshot,
} from "./controller.js"
import { nonBlockingEnabled, resolveThreshold } from "./options.js"

export function setupNonBlocking(context: Context, selectedOptions: unknown = context.options) {
  const options = isRecord(selectedOptions) ? selectedOptions : {}
  if (!nonBlockingEnabled(options)) return () => {}

  const controller = new NonBlockingController({
    thresholdMs: resolveThreshold(options.thresholdMs),
    background: (sessionID) => context.client.session.background({ sessionID }),
    lookupTool: (sessionID, assistantMessageID, toolID) => lookupTool(context, sessionID, assistantMessageID, toolID),
    lookupShell: (shellID) => {
      const shell = context.data.shell.get(shellID)
      return shell ? { status: shell.status, started: shell.time.started } : undefined
    },
    onError: () => {
      void context.ui.toast.show({
        message: "Could not move long-running work to the background",
        variant: "warning",
      })
    },
  })

  const offs = [
    context.data.on("session.tool.input.started", (event) => {
      controller.inputStarted({
        sessionID: event.data.sessionID,
        assistantMessageID: event.data.assistantMessageID,
        id: event.data.id,
        name: event.data.name,
      })
    }),
    context.data.on("session.tool.called", (event) => {
      controller.toolCalled({
        sessionID: event.data.sessionID,
        assistantMessageID: event.data.assistantMessageID,
        id: event.data.id,
        created: event.created,
      })
    }),
    context.data.on("session.tool.progress", (event) => {
      controller.toolProgress({
        sessionID: event.data.sessionID,
        assistantMessageID: event.data.assistantMessageID,
        id: event.data.id,
        created: event.created,
        metadata: event.data.metadata,
      })
    }),
    context.data.on("session.tool.success", (event) => {
      controller.toolSettled({
        sessionID: event.data.sessionID,
        assistantMessageID: event.data.assistantMessageID,
        id: event.data.id,
      })
    }),
    context.data.on("session.tool.failed", (event) => {
      controller.toolSettled({
        sessionID: event.data.sessionID,
        assistantMessageID: event.data.assistantMessageID,
        id: event.data.id,
      })
    }),
    context.data.on("shell.created", (event) => {
      controller.shellStarted(event.data.info.id, event.data.info.time.started)
    }),
    context.data.on("shell.exited", (event) => {
      if (event.data.status !== "running") controller.shellSettled(event.data.id)
    }),
    context.data.on("shell.deleted", (event) => controller.shellSettled(event.data.id)),
    context.data.on("session.deleted", (event) => controller.sessionDeleted(event.data.sessionID)),
  ]

  controller.reconcile(snapshot(context))

  return () => {
    for (const off of offs) off()
    controller.stop()
  }
}

type ToolPart = {
  type: "tool"
  id: string
  name: string
  state: { status: string; metadata?: Record<string, unknown> }
  time: { created: number; ran?: number; completed?: number }
}

function snapshot(context: Context): SessionSnapshot[] {
  const result: SessionSnapshot[] = []
  for (const session of context.data.session.list()) {
    if (context.data.session.status(session.id) !== "running") continue
    const messages = context.data.session.message.list(session.id)
    const active = messages.findLast((message) => message.type === "assistant" && !message.time.completed)
    if (active?.type !== "assistant") continue
    const tools: ToolSnapshot[] = []
    for (const part of active.content) {
      if (part.type !== "tool") continue
      const tool = part as unknown as ToolPart
      if (tool.state.status !== "running" || !toolKind(tool.name)) continue
      tools.push({
        id: tool.id,
        name: tool.name,
        status: tool.state.status,
        created: tool.time.created,
        ran: tool.time.ran,
        metadata: tool.state.metadata,
      })
    }
    if (tools.length) result.push({ sessionID: session.id, assistantMessageID: active.id, tools })
  }
  return result
}

function lookupTool(context: Context, sessionID: string, assistantMessageID: string, toolID: string): ToolSnapshot | undefined {
  const message = context.data.session.message.get(sessionID, assistantMessageID)
  if (message?.type !== "assistant") return
  const part = message.content.findLast((item) => item.type === "tool" && item.id === toolID) as ToolPart | undefined
  if (!part) return
  const metadata = isRecord(part.state.metadata) ? part.state.metadata : undefined
  return {
    id: part.id,
    name: part.name,
    status: part.state.status,
    created: part.time.created,
    ran: part.time.ran,
    metadata,
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export default Plugin.define({ id: "max10240.non-blocking.tui", setup: setupNonBlocking })
