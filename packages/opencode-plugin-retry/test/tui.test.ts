import { expect, test } from "bun:test"
import type { Context } from "@opencode/plugin/tui/context"
import { COMMAND_ID, setupRetryTui, SLASH_COMMAND } from "../src/tui.js"

type Route = { type: "home" } | { type: "session"; sessionID: string }

function harness(input: {
  options?: Record<string, unknown>
  route?: Route
  status?: "idle" | "running"
  interrupted?: boolean
  hangWait?: boolean
} = {}) {
  let layer: any
  const status = input.status ?? "idle"
  const sent: Array<Record<string, unknown>> = []
  const toasts: Array<{ message: string; variant?: string }> = []
  const calls: string[] = []
  const context = {
    options: input.options ?? {},
    keymap: {
      layer: (factory: () => unknown) => {
        layer = factory()
      },
    },
    data: {
      session: {
        status: () => status,
      },
    },
    client: {
      session: {
        interrupt: async () => {
          calls.push("interrupt")
          return { interrupted: input.interrupted ?? true }
        },
        prompt: async (value: Record<string, unknown>) => {
          calls.push("send")
          sent.push(value)
        },
      },
      experimental: {
        session: {
          wait: async (_value: unknown, options?: { signal?: AbortSignal }) => {
            calls.push("wait")
            if (!input.hangWait) return
            const signal = options?.signal
            if (signal?.aborted) throw new Error("aborted")
            await new Promise<void>((_, reject) => {
              signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true })
            })
          },
        },
      },
    },
    ui: {
      router: { current: () => input.route ?? { type: "session", sessionID: "session" } },
      toast: { show: (value: { message: string; variant?: string }) => toasts.push(value) },
    },
  } as unknown as Context
  const cleanup = setupRetryTui(context)
  return { layer, sent, toasts, calls, cleanup }
}

test("registers F5 and /retry without a palette entry or panel", () => {
  const fx = harness()
  const command = fx.layer.commands[0]
  expect(command.id).toBe(COMMAND_ID)
  expect(command.bind).toBe("f5")
  expect(command.slash).toEqual({ name: SLASH_COMMAND, arguments: true })
  expect(command.palette).toBeUndefined()
  expect(fx.layer.mode).toBeUndefined()
  expect(fx.layer.target).toBeUndefined()
  fx.cleanup?.()
})

test("idle sends Continue without interrupting", async () => {
  const fx = harness()
  fx.layer.commands[0].run()
  await Bun.sleep(0)
  expect(fx.calls).toEqual(["send"])
  expect(fx.sent).toEqual([{ sessionID: "session", text: "Continue", delivery: "steer" }])
  fx.cleanup?.()
})

test("running interrupts, waits, then sends Continue", async () => {
  const fx = harness({ status: "running" })
  fx.layer.commands[0].run()
  await Bun.sleep(0)
  expect(fx.calls).toEqual(["interrupt", "wait", "send"])
  fx.cleanup?.()
})

test("an interrupt that finds the turn still stopping waits before sending", async () => {
  const fx = harness({ status: "running", interrupted: false })
  fx.layer.commands[0].run()
  await Bun.sleep(0)
  expect(fx.calls).toEqual(["interrupt", "wait", "send"])
  fx.cleanup?.()
})

test("a slow settlement queues Continue instead of failing", async () => {
  const fx = harness({ status: "running", hangWait: true, options: { timeoutMs: 20 } })
  fx.layer.commands[0].run()
  for (let attempt = 0; attempt < 100 && fx.sent.length === 0; attempt++) await Bun.sleep(5)
  expect(fx.calls).toEqual(["interrupt", "wait", "send"])
  expect(fx.sent).toEqual([{ sessionID: "session", text: "Continue", delivery: "queue" }])
  expect(fx.toasts).toEqual([{ message: "Retry: prompt queued until the current turn stops", variant: "warning" }])
  fx.cleanup?.()
})

test("no session shows a warning and never prompts", async () => {
  const fx = harness({ route: { type: "home" } })
  fx.layer.commands[0].run()
  await Bun.sleep(0)
  expect(fx.sent).toEqual([])
  expect(fx.toasts).toEqual([{ message: "Open a session first", variant: "warning" }])
  fx.cleanup?.()
})

test("the feature switch removes the command entirely", () => {
  const fx = harness({ options: { features: { retry: false } } })
  expect(fx.layer).toBeUndefined()
  expect(fx.cleanup).toBeUndefined()
})

test("a disabled keybind keeps the slash command", () => {
  const fx = harness({ options: { keybind: false } })
  expect(fx.layer.commands[0].bind).toBe(false)
  expect(fx.layer.commands[0].slash).toEqual({ name: SLASH_COMMAND, arguments: true })
  fx.cleanup?.()
})
