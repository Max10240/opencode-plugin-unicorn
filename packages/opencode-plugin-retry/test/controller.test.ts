import { expect, test } from "bun:test"
import { RetryController, type RetryControllerOptions } from "../src/controller.js"

function fixture(overrides: Partial<RetryControllerOptions> = {}) {
  const calls: string[] = []
  const errors: string[] = []
  const sent: boolean[] = []
  const queued: boolean[] = []
  const controller = new RetryController({
    continueText: "Continue",
    timeoutMs: 1_000,
    status: () => "idle",
    interrupt: async () => {
      calls.push("interrupt")
      return { interrupted: true }
    },
    waitIdle: async () => {
      calls.push("wait")
    },
    send: async (_sessionID, text) => {
      calls.push(`send:${text}`)
    },
    enqueue: async (_sessionID, text) => {
      calls.push(`enqueue:${text}`)
    },
    onError: (message) => errors.push(message),
    onSent: (interrupted) => sent.push(interrupted),
    onQueued: (interrupted) => queued.push(interrupted),
    ...overrides,
  })
  return { controller, calls, errors, sent, queued }
}

test("idle sends Continue without interrupting", async () => {
  const fx = fixture()
  expect(await fx.controller.run("session")).toEqual({ status: "sent", interrupted: false })
  expect(fx.calls).toEqual(["send:Continue"])
  expect(fx.sent).toEqual([false])
  expect(fx.errors).toEqual([])
})

test("running interrupts, waits for settlement, then sends Continue", async () => {
  const fx = fixture({ status: () => "running" })
  expect(await fx.controller.run("session")).toEqual({ status: "sent", interrupted: true })
  expect(fx.calls).toEqual(["interrupt", "wait", "send:Continue"])
  expect(fx.sent).toEqual([true])
})

test("an interrupt that finds the turn already idle sends Continue without waiting", async () => {
  let status: "idle" | "running" = "running"
  const fx = fixture({
    status: () => status,
    interrupt: async () => {
      status = "idle"
      return { interrupted: false }
    },
  })
  expect(await fx.controller.run("session")).toEqual({ status: "sent", interrupted: false })
  expect(fx.calls).toEqual(["send:Continue"])
})

test("an interrupt that finds the turn still stopping waits before sending", async () => {
  const fx = fixture({
    status: () => "running",
    interrupt: async () => ({ interrupted: false }),
  })
  expect(await fx.controller.run("session")).toEqual({ status: "sent", interrupted: false })
  expect(fx.calls).toEqual(["wait", "send:Continue"])
})

test("interrupt failures do not send Continue", async () => {
  const fx = fixture({
    status: () => "running",
    interrupt: async () => {
      throw new Error("abort failed")
    },
  })
  expect(await fx.controller.run("session")).toEqual({ status: "failed", reason: "interrupt" })
  expect(fx.calls).toEqual([])
  expect(fx.errors).toEqual(["Retry failed: could not interrupt the current turn"])
})

test("settlement failures do not send Continue", async () => {
  const fx = fixture({
    status: () => "running",
    waitIdle: async () => {
      throw new Error("wait failed")
    },
  })
  expect(await fx.controller.run("session")).toEqual({ status: "failed", reason: "wait" })
  expect(fx.calls).toEqual(["interrupt"])
  expect(fx.errors).toEqual(["Retry failed: could not finish interrupting the current turn"])
})

test("settlement timeouts queue Continue instead of dropping it", async () => {
  const fx = fixture({
    status: () => "running",
    createTimeoutSignal: () => AbortSignal.abort(),
    waitIdle: async () => {
      throw new Error("aborted")
    },
  })
  expect(await fx.controller.run("session")).toEqual({ status: "queued", interrupted: true })
  expect(fx.calls).toEqual(["interrupt", "enqueue:Continue"])
  expect(fx.queued).toEqual([true])
  expect(fx.errors).toEqual([])
})

test("a timeout that races with settlement still steers Continue", async () => {
  let status: "idle" | "running" = "running"
  const fx = fixture({
    status: () => status,
    createTimeoutSignal: () => AbortSignal.abort(),
    waitIdle: async () => {
      status = "idle"
      throw new Error("aborted")
    },
  })
  expect(await fx.controller.run("session")).toEqual({ status: "sent", interrupted: true })
  expect(fx.calls).toEqual(["interrupt", "send:Continue"])
  expect(fx.queued).toEqual([])
})

test("queue failures are reported without a second send", async () => {
  const fx = fixture({
    status: () => "running",
    createTimeoutSignal: () => AbortSignal.abort(),
    waitIdle: async () => {
      throw new Error("aborted")
    },
    enqueue: async () => {
      throw new Error("queue failed")
    },
  })
  expect(await fx.controller.run("session")).toEqual({ status: "failed", reason: "queue" })
  expect(fx.calls).toEqual(["interrupt"])
  expect(fx.errors).toEqual(["Retry failed: could not queue Continue"])
})

test("send failures are reported without a second send", async () => {
  const fx = fixture({
    send: async () => {
      throw new Error("send failed")
    },
  })
  expect(await fx.controller.run("session")).toEqual({ status: "failed", reason: "send" })
  expect(fx.errors).toEqual(["Retry failed: could not send Continue"])
})

test("status failures do not interrupt or send", async () => {
  const fx = fixture({ status: () => { throw new Error("status failed") } })
  expect(await fx.controller.run("session")).toEqual({ status: "failed", reason: "status" })
  expect(fx.calls).toEqual([])
  expect(fx.errors).toEqual(["Retry failed: could not read the session state"])
})

test("overlapping retries for one session run once", async () => {
  const pending = Promise.withResolvers<void>()
  let sends = 0
  const fx = fixture({
    send: async () => {
      sends++
      await pending.promise
    },
  })
  const first = fx.controller.run("session")
  const second = fx.controller.run("session")
  expect(await second).toEqual({ status: "ignored" })
  pending.resolve()
  expect(await first).toEqual({ status: "sent", interrupted: false })
  expect(sends).toBe(1)
})

test("disposing during settlement prevents the Continue send", async () => {
  const pending = Promise.withResolvers<void>()
  const fx = fixture({
    status: () => "running",
    waitIdle: async () => {
      await pending.promise
    },
  })
  const running = fx.controller.run("session")
  fx.controller.dispose()
  pending.resolve()
  expect(await running).toEqual({ status: "ignored" })
  expect(fx.calls).toEqual(["interrupt"])
})
