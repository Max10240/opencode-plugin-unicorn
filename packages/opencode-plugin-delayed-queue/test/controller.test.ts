import { expect, test } from "bun:test"
import {
  DelayedQueueController,
  type DelayedQueueBackground,
  type DelayedQueueJob,
  type DelayedQueueStatus,
  type PersistedDelayedQueue,
} from "../src/controller.js"
import { WAIT_KINDS } from "../src/options.js"

const START = 10_000
const RECHECK = 1_000

function fixture(options: { failDeliveries?: number; waitKinds?: readonly (typeof WAIT_KINDS)[number][] } = {}) {
  let now = START
  let nextTimer = 0
  const timers = new Map<number, { at: number; run: () => void }>()
  const busy = new Set<string>()
  const parents = new Map<string, string>()
  const delivered: Array<{ sessionID: string; text: string; id: string }> = []
  const saved: PersistedDelayedQueue[] = []
  const statuses: DelayedQueueStatus[] = []
  const errors: unknown[] = []
  let failures = options.failDeliveries ?? 0

  const controller = new DelayedQueueController({
    boot: "boot-a",
    recheckMs: RECHECK,
    waitKinds: options.waitKinds ?? WAIT_KINDS,
    waitDescendants: true,
    pauseOnInterrupt: true,
    pauseOnFailure: true,
    now: () => now,
    timers: {
      setTimeout: (run, delay) => {
        const id = ++nextTimer
        timers.set(id, { at: now + delay, run })
        return id
      },
      clearTimeout: (timer) => {
        timers.delete(timer as number)
      },
    },
    isBusy: async (sessionID) => busy.has(sessionID),
    parentOf: async (sessionID) => parents.get(sessionID),
    deliver: async (sessionID, item) => {
      if (failures > 0) {
        failures -= 1
        throw new Error("delivery failed")
      }
      delivered.push({ sessionID, text: item.text, id: item.id })
    },
    save: async (_sessionID, state) => {
      saved.push(state)
    },
    onChange: (status) => {
      statuses.push(status)
    },
    onError: (error) => {
      errors.push(error)
    },
  })

  const flush = async () => {
    for (let index = 0; index < 20; index++) await Promise.resolve()
  }

  const advance = async (ms: number) => {
    const target = now + ms
    for (;;) {
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

  return {
    controller,
    advance,
    flush,
    delivered,
    saved,
    statuses,
    errors,
    busy,
    parents,
    now: () => now,
    job(overrides: Partial<DelayedQueueJob> & Pick<DelayedQueueJob, "id" | "kind" | "sessionID">): DelayedQueueJob {
      return { status: "running", ...overrides }
    },
  }
}

function ownShell(sessionID: string, shellID = "sh1"): DelayedQueueBackground {
  return { kind: "shell", sessionID, shellID, command: "bun test" }
}

function childShell(sessionID: string, shellID = "sh-child"): DelayedQueueBackground {
  return { kind: "shell", sessionID, shellID, command: "bun dev" }
}

test("delivers immediately when the session is idle and the job list is empty", async () => {
  const fx = fixture()
  const status = await fx.controller.enqueue("s1", "later", [])
  expect(fx.delivered).toMatchObject([{ sessionID: "s1", text: "later" }])
  expect(fx.delivered[0]?.id).toMatch(/^msg_/)
  expect(status.items).toEqual([])
  expect(status.observed).toBe(true)
})

test("waits for a busy session and delivers at the idle hook", async () => {
  const fx = fixture()
  fx.busy.add("s1")
  await fx.controller.enqueue("s1", "later", [])
  expect(fx.delivered).toEqual([])
  fx.busy.delete("s1")
  await fx.controller.onIdle("s1", [])
  expect(fx.delivered.map((item) => item.text)).toEqual(["later"])
})

test("waits while the session owns background work and the wake re-runs the hook", async () => {
  const fx = fixture()
  fx.busy.add("s1")
  await fx.controller.enqueue("s1", "later", [])
  fx.busy.delete("s1")
  await fx.controller.onIdle("s1", [ownShell("s1")])
  expect(fx.delivered).toEqual([])
  await fx.controller.onIdle("s1", [])
  expect(fx.delivered.map((item) => item.text)).toEqual(["later"])
})

test("waits for descendant background work until the descendant re-idles", async () => {
  const fx = fixture()
  fx.parents.set("child", "s1")
  fx.busy.add("s1")
  await fx.controller.enqueue("s1", "later", [])
  fx.busy.delete("s1")
  await fx.controller.onIdle("s1", [childShell("child")])
  expect(fx.delivered).toEqual([])
  await fx.advance(RECHECK)
  expect(fx.delivered).toEqual([])
  await fx.controller.onIdle("child", [])
  await fx.advance(RECHECK)
  expect(fx.delivered.map((item) => item.text)).toEqual(["later"])
})

test("pauses on a user interrupt and resumes only after a fresh user prompt", async () => {
  const fx = fixture()
  fx.busy.add("s1")
  await fx.controller.enqueue("s1", "later", [])
  await fx.controller.onExecutionInterrupted("s1", "user")
  expect(fx.controller.status("s1").paused).toBe(true)
  await fx.controller.onPrompt("s1", false)
  expect(fx.controller.status("s1").paused).toBe(false)
  expect(fx.delivered).toEqual([])
  await fx.controller.onIdle("s1", [])
  expect(fx.delivered.map((item) => item.text)).toEqual(["later"])
})

test("does not pause when no message is waiting", async () => {
  const fx = fixture()
  await fx.controller.onExecutionInterrupted("s1", "user")
  expect(fx.controller.status("s1").paused).toBe(false)
  await fx.controller.onExecutionFailed("s1")
  expect(fx.controller.status("s1").paused).toBe(false)
})

test("pauses on execution failure", async () => {
  const fx = fixture()
  fx.busy.add("s1")
  await fx.controller.enqueue("s1", "later", [])
  await fx.controller.onExecutionFailed("s1")
  expect(fx.controller.status("s1").paused).toBe(true)
  expect(fx.controller.status("s1").pauseReason).toBe("failed")
})

test("delivers one message per idle boundary in FIFO order", async () => {
  const fx = fixture()
  fx.busy.add("s1")
  await fx.controller.enqueue("s1", "first", [])
  await fx.controller.enqueue("s1", "second", [])
  expect(fx.delivered).toEqual([])
  fx.busy.delete("s1")
  await fx.controller.onIdle("s1", [])
  expect(fx.delivered.map((item) => item.text)).toEqual(["first"])
  await fx.controller.onIdle("s1", [])
  expect(fx.delivered.map((item) => item.text)).toEqual(["first", "second"])
})

test("steer now overrides a pause and background work", async () => {
  const fx = fixture()
  fx.busy.add("s1")
  const status = await fx.controller.enqueue("s1", "first", [])
  const id = status.items[0]!.id
  await fx.controller.onExecutionInterrupted("s1", "user")
  await fx.controller.deliverNow("s1", id)
  expect(fx.delivered.map((item) => item.text)).toEqual(["first"])
  expect(fx.controller.status("s1").items).toEqual([])
})

test("removes and clears messages", async () => {
  const fx = fixture()
  fx.busy.add("s1")
  const status = await fx.controller.enqueue("s1", "first", [])
  await fx.controller.enqueue("s1", "second", [])
  expect(fx.controller.status("s1").items).toHaveLength(2)
  await fx.controller.remove("s1", [status.items[0]!.id])
  expect(fx.controller.status("s1").items.map((item) => item.text)).toEqual(["second"])
  await fx.controller.clear("s1")
  expect(fx.controller.status("s1").items).toEqual([])
})

test("hydrates a previous process as paused and resumes delivery", async () => {
  const fx = fixture()
  fx.controller.hydrate("s1", {
    version: 1,
    boot: "boot-old",
    paused: false,
    items: [{ id: "msg_old", text: "old", createdAt: START }],
    updatedAt: START,
  })
  expect(fx.controller.status("s1")).toMatchObject({ paused: true, pauseReason: "restart" })
  await fx.controller.resume("s1")
  expect(fx.delivered.map((item) => item.text)).toEqual(["old"])
})

test("pauses after three delivery failures", async () => {
  const fx = fixture({ failDeliveries: 3 })
  await fx.controller.enqueue("s1", "later", [])
  expect(fx.delivered).toEqual([])
  await fx.advance(RECHECK)
  await fx.advance(RECHECK)
  expect(fx.controller.status("s1")).toMatchObject({ paused: true, pauseReason: "delivery" })
  expect(fx.errors).toHaveLength(3)
})

test("ignores background kinds outside waitKinds", async () => {
  const fx = fixture({ waitKinds: ["subagent"] })
  fx.busy.add("s1")
  const job = fx.job({ id: "shell-1", kind: "shell", sessionID: "s1", shellID: "sh1", command: "bun dev" })
  fx.controller.onJob(job)
  await fx.controller.enqueue("s1", "later", [job])
  fx.busy.delete("s1")
  await fx.controller.onIdle("s1", [ownShell("s1")])
  expect(fx.delivered.map((item) => item.text)).toEqual(["later"])
})

test("finds a subagent background job owned by a grandchild", async () => {
  const fx = fixture()
  fx.parents.set("child", "s1")
  fx.parents.set("grandchild", "child")
  const child = fx.job({ id: "sub", kind: "subagent", sessionID: "child", childSessionID: "grandchild" })
  fx.controller.onJob(child)
  await fx.controller.enqueue("s1", "later", [child])
  await fx.advance(RECHECK)
  expect(fx.delivered).toEqual([])
  fx.controller.onJob({ ...child, status: "completed" })
  await fx.advance(RECHECK)
  expect(fx.delivered.map((item) => item.text)).toEqual(["later"])
})

test("deletes a session queue", async () => {
  const fx = fixture()
  fx.busy.add("s1")
  await fx.controller.enqueue("s1", "later", [])
  await fx.controller.onSessionDeleted("s1")
  expect(fx.controller.status("s1").items).toEqual([])
})

test("delivers an unobserved idle session after one recheck", async () => {
  const fx = fixture()
  await fx.controller.enqueue("s1", "later")
  expect(fx.delivered).toEqual([])
  await fx.advance(RECHECK)
  expect(fx.delivered.map((item) => item.text)).toEqual(["later"])
})

test("syncJobs releases a queue when the server reports no running jobs", async () => {
  const fx = fixture()
  const job = fx.job({ id: "shell-sync", kind: "shell", sessionID: "s1", shellID: "sh-sync", command: "bun test" })
  await fx.controller.enqueue("s1", "later", [job])
  expect(fx.delivered).toEqual([])
  await fx.controller.syncJobs("s1", [])
  expect(fx.delivered.map((item) => item.text)).toEqual(["later"])
})

test("a recheck releases own background work when the notice is missed", async () => {
  const fx = fixture()
  const job = fx.job({ id: "shell-own", kind: "shell", sessionID: "s1", shellID: "sh1", command: "bun test" })
  await fx.controller.enqueue("s1", "later", [job])
  await fx.controller.onIdle("s1", [ownShell("s1")])
  await fx.advance(RECHECK)
  expect(fx.delivered).toEqual([])
  fx.controller.onJob({ ...job, status: "completed" })
  await fx.advance(RECHECK)
  expect(fx.delivered.map((item) => item.text)).toEqual(["later"])
})
