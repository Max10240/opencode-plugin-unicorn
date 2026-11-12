import { expect, test } from "bun:test"
import { NonBlockingController, type ShellSnapshot, type Timer, type ToolSnapshot } from "../src/controller.js"

const START = 1_000

function fixture(options: {
  thresholdMs?: number
  retryDelays?: readonly number[]
  shell?: (id: string) => ShellSnapshot | undefined
  tool?: (sessionID: string, messageID: string, toolID: string) => ToolSnapshot | undefined
  fail?: () => boolean
  gate?: Promise<void>
} = {}) {
  let now = START
  let nextTimer = 0
  const timers = new Map<number, { at: number; run: () => void }>()
  const calls: string[] = []
  const backgrounded: string[] = []
  const errors: string[] = []
  const controller = new NonBlockingController({
    thresholdMs: options.thresholdMs ?? 10_000,
    retryDelays: options.retryDelays ?? [1_000, 3_000, 5_000],
    now: () => now,
    setTimeout: (run, delay) => {
      const id = ++nextTimer
      timers.set(id, { at: now + delay, run })
      return id as unknown as Timer
    },
    clearTimeout: (timer) => timers.delete(timer as unknown as number),
    background: async (sessionID) => {
      calls.push(sessionID)
      if (options.gate) await options.gate
      if (options.fail?.()) throw new Error("background failed")
    },
    lookupShell: options.shell,
    lookupTool: options.tool,
    onBackground: (sessionID) => backgrounded.push(sessionID),
    onError: (_error, sessionID) => errors.push(sessionID),
  })
  const flush = async () => {
    for (let index = 0; index < 8; index++) await Promise.resolve()
  }
  const advance = async (ms: number) => {
    const target = now + ms
    while (true) {
      let pick: [number, { at: number; run: () => void }] | undefined
      for (const entry of timers) {
        if (entry[1].at > target) continue
        if (!pick || entry[1].at < pick[1].at) pick = entry
      }
      if (!pick) break
      now = pick[1].at
      timers.delete(pick[0])
      pick[1].run()
      await flush()
    }
    now = target
    await flush()
  }
  return { controller, advance, flush, calls, backgrounded, errors, now: () => now }
}

function shell(controller: NonBlockingController, sessionID: string, id: string, created = START, shellID = `sh_${id}`) {
  controller.inputStarted({ sessionID, assistantMessageID: "m", id, name: "shell" })
  controller.toolCalled({ sessionID, assistantMessageID: "m", id, created })
  controller.toolProgress({ sessionID, assistantMessageID: "m", id, created, metadata: { shellID } })
}

function subagent(controller: NonBlockingController, sessionID: string, id: string, created = START) {
  controller.inputStarted({ sessionID, assistantMessageID: "m", id, name: "subagent" })
  controller.toolCalled({ sessionID, assistantMessageID: "m", id, created })
  controller.toolProgress({
    sessionID,
    assistantMessageID: "m",
    id,
    created,
    metadata: { sessionID: `ses_child_${id}`, status: "running" },
  })
}

test("waits for the threshold and backgrounds a blocking shell once", async () => {
  const fx = fixture()
  shell(fx.controller, "s", "t")
  await fx.advance(9_999)
  expect(fx.calls).toEqual([])
  await fx.advance(1)
  expect(fx.calls).toEqual(["s"])
  expect(fx.backgrounded).toEqual(["s"])
  await fx.advance(20_000)
  expect(fx.calls).toEqual(["s"])
})

test("manual background removes the candidate so a later command keeps its own deadline", async () => {
  const fx = fixture()
  shell(fx.controller, "s", "a", START)
  await fx.advance(3_000)
  fx.controller.toolSettled({ sessionID: "s", assistantMessageID: "m", id: "a" })
  shell(fx.controller, "s", "b", fx.now())
  await fx.advance(6_000)
  expect(fx.calls).toEqual([])
  await fx.advance(4_000)
  expect(fx.calls).toEqual(["s"])
})

test("one due tool backgrounds all blocking work in that session and never triggers twice", async () => {
  const fx = fixture()
  shell(fx.controller, "s", "a", START)
  shell(fx.controller, "s", "b", fx.now())
  await fx.advance(10_000)
  expect(fx.calls).toEqual(["s"])
  expect(fx.controller.size).toBe(0)
  await fx.advance(10_000)
  expect(fx.calls).toEqual(["s"])
})

test("sessions are independent", async () => {
  const fx = fixture()
  shell(fx.controller, "s1", "a", START)
  shell(fx.controller, "s2", "b", START + 3_000)
  await fx.advance(10_000)
  expect(fx.calls).toEqual(["s1"])
  await fx.advance(3_000)
  expect(fx.calls).toEqual(["s1", "s2"])
})

test("subagents are monitored like blocking shells", async () => {
  const fx = fixture()
  subagent(fx.controller, "parent", "task")
  await fx.advance(10_000)
  expect(fx.calls).toEqual(["parent"])
})

test("completed tools and exited shells are not backgrounded", async () => {
  const finished = fixture()
  shell(finished.controller, "s", "a")
  finished.controller.toolSettled({ sessionID: "s", assistantMessageID: "m", id: "a" })
  await finished.advance(20_000)
  expect(finished.calls).toEqual([])

  const exited = fixture()
  shell(exited.controller, "s", "b")
  exited.controller.shellSettled("sh_b")
  await exited.advance(20_000)
  expect(exited.calls).toEqual([])
})

test("uses the shell start time when it is known", async () => {
  const fx = fixture({ shell: () => ({ status: "running", started: START + 500 }) })
  shell(fx.controller, "s", "a", START)
  await fx.advance(10_000)
  expect(fx.calls).toEqual([])
  await fx.advance(500)
  expect(fx.calls).toEqual(["s"])
})

test("uses a later shell start when the shell creation event arrives after progress", async () => {
  const fx = fixture()
  shell(fx.controller, "s", "a", START)
  fx.controller.shellStarted("sh_a", START + 5_000)
  await fx.advance(10_000)
  expect(fx.calls).toEqual([])
  await fx.advance(5_000)
  expect(fx.calls).toEqual(["s"])
})

test("uses a shell start seen before its progress event", async () => {
  const fx = fixture()
  fx.controller.shellStarted("sh_a", START + 5_000)
  shell(fx.controller, "s", "a", START)
  await fx.advance(10_000)
  expect(fx.calls).toEqual([])
  await fx.advance(5_000)
  expect(fx.calls).toEqual(["s"])
})

test("reconcile seeds running blocking tools", async () => {
  const fx = fixture()
  fx.controller.reconcile([{
    sessionID: "s",
    assistantMessageID: "m",
    tools: [{ id: "a", name: "shell", status: "running", created: START, metadata: { shellID: "sh_a" } }],
  }])
  await fx.advance(10_000)
  expect(fx.calls).toEqual(["s"])
})

test("reconcile ignores completed and unrelated tools", async () => {
  const fx = fixture()
  fx.controller.reconcile([{
    sessionID: "s",
    assistantMessageID: "m",
    tools: [
      { id: "a", name: "shell", status: "completed", created: START, metadata: { shellID: "sh_a" } },
      { id: "b", name: "read", status: "running", created: START },
    ],
  }])
  await fx.advance(20_000)
  expect(fx.calls).toEqual([])
})

test("retries transient background failures and stops after the configured attempts", async () => {
  let failures = 1
  const recovered = fixture({ retryDelays: [100], fail: () => failures-- > 0 })
  shell(recovered.controller, "s", "a")
  await recovered.advance(10_000)
  expect(recovered.calls).toEqual(["s"])
  await recovered.advance(100)
  expect(recovered.calls).toEqual(["s", "s"])
  expect(recovered.backgrounded).toEqual(["s"])
  expect(recovered.errors).toEqual([])

  const exhausted = fixture({ retryDelays: [100, 100], fail: () => true })
  shell(exhausted.controller, "s", "b")
  await exhausted.advance(10_000)
  await exhausted.advance(100)
  await exhausted.advance(100)
  expect(exhausted.calls).toHaveLength(3)
  expect(exhausted.errors).toEqual(["s"])
})

test("a tool that starts during an in-flight background call keeps its own deadline", async () => {
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  const fx = fixture({ gate })
  shell(fx.controller, "s", "a")
  await fx.advance(10_000)
  expect(fx.calls).toEqual(["s"])
  shell(fx.controller, "s", "b", fx.now())
  release()
  await fx.advance(0)
  expect(fx.controller.size).toBe(1)
  await fx.advance(10_000)
  expect(fx.calls).toEqual(["s", "s"])
})

test("session deletion and stop clear pending work", async () => {
  const deleted = fixture()
  shell(deleted.controller, "s", "a")
  deleted.controller.sessionDeleted("s")
  await deleted.advance(20_000)
  expect(deleted.calls).toEqual([])

  const stopped = fixture()
  shell(stopped.controller, "s", "b")
  stopped.controller.stop()
  await stopped.advance(20_000)
  expect(stopped.calls).toEqual([])
})
