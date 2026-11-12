import { expect, test } from "bun:test"
import type { Context } from "@opencode/plugin/tui/context"
import { setupNonBlocking } from "../src/tui.js"
import { nonBlockingEnabled, resolveThreshold } from "../src/options.js"

function fixture(options: { sessions?: any[]; shell?: any } = {}) {
  const calls: string[] = []
  const toasts: string[] = []
  const handlers = new Map<string, Set<(event: any) => void>>()
  const context = {
    options: {},
    client: {
      session: {
        background: async (input: { sessionID: string }) => {
          calls.push(input.sessionID)
        },
      },
    },
    data: {
      on: (type: string, handler: (event: any) => void) => {
        const set = handlers.get(type) ?? new Set()
        set.add(handler)
        handlers.set(type, set)
        return () => set.delete(handler)
      },
      session: {
        list: () => options.sessions ?? [],
        status: () => "running",
        message: {
          list: (sessionID: string) => options.sessions?.find((session) => session.id === sessionID)?.messages ?? [],
          get: (sessionID: string, messageID: string) =>
            options.sessions?.find((session) => session.id === sessionID)?.messages?.find((message: any) => message.id === messageID),
        },
      },
      shell: {
        get: () => options.shell ?? { status: "running", time: { started: Date.now() - 1_000 } },
      },
    },
    ui: { toast: { show: (input: { message: string }) => { toasts.push(input.message) } } },
  } as unknown as Context
  const emit = (type: string, event: any) => {
    for (const handler of handlers.get(type) ?? []) handler(event)
  }
  return { context, calls, toasts, handlers, emit }
}

async function waitFor(check: () => boolean, message: string) {
  const deadline = Date.now() + 2_000
  while (Date.now() < deadline) {
    if (check()) return
    await Bun.sleep(5)
  }
  throw new Error(message)
}

test("resolves options with a ten second default", () => {
  expect(resolveThreshold(undefined)).toBe(10_000)
  expect(resolveThreshold(-1)).toBe(10_000)
  expect(resolveThreshold(2_500.9)).toBe(2_500)
  expect(nonBlockingEnabled({})).toBe(true)
  expect(nonBlockingEnabled({ enabled: false })).toBe(false)
  expect(nonBlockingEnabled({ features: { nonBlocking: false } })).toBe(false)
})

test("backgrounds a due blocking tool and stops listening on cleanup", async () => {
  const fx = fixture()
  const stop = setupNonBlocking(fx.context, { thresholdMs: 20 })
  fx.emit("session.tool.progress", {
    created: Date.now(),
    data: { sessionID: "s", assistantMessageID: "m", id: "tool", metadata: { shellID: "sh_tool" } },
  })
  await waitFor(() => fx.calls.length === 1, "due shell was not backgrounded")
  expect(fx.calls).toEqual(["s"])
  stop()
  fx.emit("session.tool.progress", {
    created: Date.now(),
    data: { sessionID: "s2", assistantMessageID: "m2", id: "tool2", metadata: { shellID: "sh_tool2" } },
  })
  await Bun.sleep(50)
  expect(fx.calls).toEqual(["s"])
})

test("seeds a running shell from existing messages", async () => {
  const now = Date.now()
  const fx = fixture({
    sessions: [{
      id: "s",
      messages: [{
        id: "m",
        type: "assistant",
        time: { created: now - 1_000 },
        content: [{
          type: "tool",
          id: "tool",
          name: "shell",
          state: { status: "running", metadata: { shellID: "sh_tool" } },
          time: { created: now - 1_000, ran: now - 1_000 },
        }],
      }],
    }],
  })
  const stop = setupNonBlocking(fx.context, { thresholdMs: 20 })
  await waitFor(() => fx.calls.length === 1, "due shell was not backgrounded")
  expect(fx.calls).toEqual(["s"])
  stop()
})

test("tracks a subagent progress event", async () => {
  const fx = fixture({ shell: undefined })
  const stop = setupNonBlocking(fx.context, { thresholdMs: 20 })
  fx.emit("session.tool.progress", {
    created: Date.now() - 1_000,
    data: {
      sessionID: "parent",
      assistantMessageID: "m",
      id: "tool",
      metadata: { sessionID: "ses_child", status: "running" },
    },
  })
  await waitFor(() => fx.calls.length === 1, "subagent was not backgrounded")
  expect(fx.calls).toEqual(["parent"])
  stop()
})

test("disabled setup registers nothing", async () => {
  const fx = fixture()
  const stop = setupNonBlocking(fx.context, { enabled: false, thresholdMs: 1 })
  expect(fx.handlers.size).toBe(0)
  fx.emit("session.tool.progress", {
    created: Date.now(),
    data: { sessionID: "s", assistantMessageID: "m", id: "tool", metadata: { shellID: "sh_tool" } },
  })
  await Bun.sleep(20)
  expect(fx.calls).toEqual([])
  stop()
})
