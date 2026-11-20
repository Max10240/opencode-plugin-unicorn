import { expect, test } from "bun:test"
import {
  InfiniteLoopController,
  isSessionBusy,
  type InfiniteLoopBackground,
  type InfiniteLoopStatus,
} from "../src/controller.js"

const START = 10_000
const DELAY_MS = 3_000
const RECHECK_MS = 2_000
const DAY_MS = 86_400_000
const MAX_TIMER_MS = 2_147_000_000

type FixtureOptions = {
  delayMs?: number
  recheckMs?: number
  cooldownMs?: number
  live?: boolean
}

type Fixture = {
  controller: InfiniteLoopController
  advance: (ms: number) => Promise<void>
  flush: () => Promise<void>
  sent: Array<{ sessionID: string; at: number }>
  busyCalls: string[]
  errors: unknown[]
  states: Array<{ sessionID: string; status: InfiniteLoopStatus }>
  now: () => number
  busy: (sessionID: string) => void
  idle: (sessionID: string) => void
  runWork: (sessionID: string) => void
  stopWork: (sessionID: string) => void
  setBusyGate: (gate: Promise<void> | undefined) => void
  setWorkGate: (gate: Promise<void> | undefined) => void
  setSendGate: (gate: Promise<void> | undefined) => void
  setSendError: (error: Error | undefined) => void
  setBusyError: (error: Error | undefined) => void
  setWorkError: (error: Error | undefined) => void
}

function fixture(options: FixtureOptions = {}): Fixture {
  let now = START
  let nextTimer = 0
  const timers = new Map<number, { at: number; run: () => void }>()
  const busySessions = new Set<string>()
  const runningSessions = new Set<string>()
  const sent: Array<{ sessionID: string; at: number }> = []
  const busyCalls: string[] = []
  const errors: unknown[] = []
  const states: Array<{ sessionID: string; status: InfiniteLoopStatus }> = []
  let busyGate: Promise<void> | undefined
  let workGate: Promise<void> | undefined
  let sendGate: Promise<void> | undefined
  let sendError: Error | undefined
  let busyError: Error | undefined
  let workError: Error | undefined

  const controller = new InfiniteLoopController({
    delayMs: options.delayMs ?? DELAY_MS,
    recheckMs: options.recheckMs ?? RECHECK_MS,
    cooldownMs: options.cooldownMs ?? 0,
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
    isBusy: async (sessionID) => {
      busyCalls.push(sessionID)
      if (busyError) throw busyError
      if (busyGate) await busyGate
      return busySessions.has(sessionID)
    },
    ...(options.live === false
      ? {}
      : {
          hasRunningWork: async (sessionID: string) => {
            if (workError) throw workError
            if (workGate) await workGate
            return runningSessions.has(sessionID)
          },
        }),
    send: async (sessionID) => {
      if (sendGate) await sendGate
      if (sendError) throw sendError
      sent.push({ sessionID, at: now })
    },
    onError: (error) => {
      errors.push(error)
    },
    onState: (sessionID, status) => {
      states.push({ sessionID, status })
    },
  })

  const flush = async () => {
    for (let index = 0; index < 30; index++) await Promise.resolve()
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
    sent,
    busyCalls,
    errors,
    states,
    now: () => now,
    busy: (sessionID) => busySessions.add(sessionID),
    idle: (sessionID) => busySessions.delete(sessionID),
    runWork: (sessionID) => runningSessions.add(sessionID),
    stopWork: (sessionID) => runningSessions.delete(sessionID),
    setBusyGate: (gate) => { busyGate = gate },
    setWorkGate: (gate) => { workGate = gate },
    setSendGate: (gate) => { sendGate = gate },
    setSendError: (error) => { sendError = error },
    setBusyError: (error) => { busyError = error },
    setWorkError: (error) => { workError = error },
  }
}

function own(work: { sessionID: string } & Record<string, unknown>): InfiniteLoopBackground {
  return { kind: "shell", ...work } as InfiniteLoopBackground
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

test("nudges once the quiet window elapses on an idle session", async () => {
  const fx = fixture()
  fx.controller.start("s1", 60 * 60_000, true)
  await fx.advance(DELAY_MS)
  expect(fx.sent.map((entry) => entry.sessionID)).toEqual(["s1"])
  expect(fx.controller.status("s1")).toMatchObject({ active: true, sentCount: 1 })
})

test("waits for the next idle boundary when the session is busy at start", async () => {
  const fx = fixture()
  fx.busy("s1")
  fx.controller.start("s1", 60 * 60_000, false)
  await fx.advance(DELAY_MS)
  expect(fx.sent).toEqual([])
  fx.idle("s1")
  fx.controller.onIdle("s1", [])
  await fx.advance(DELAY_MS)
  expect(fx.sent.map((entry) => entry.sessionID)).toEqual(["s1"])
})

test("a prompt during the quiet window cancels the nudge", async () => {
  const fx = fixture()
  fx.controller.start("s1", 60 * 60_000, true)
  await fx.advance(1_000)
  fx.controller.onPrompt("s1", false)
  await fx.advance(DELAY_MS)
  expect(fx.sent).toEqual([])
  expect(fx.controller.status("s1")).toMatchObject({ active: true, sentCount: 0, lastInputAt: START + 1_000 })
})

test("own nudges do not cancel pending windows", async () => {
  const fx = fixture()
  fx.controller.start("s1", 60 * 60_000, true)
  fx.controller.onPrompt("s1", true)
  await fx.advance(DELAY_MS)
  expect(fx.sent.map((entry) => entry.sessionID)).toEqual(["s1"])
})

test("the loop repeats after each nudge turn completes", async () => {
  const fx = fixture()
  fx.controller.start("s1", 60 * 60_000, true)
  await fx.advance(DELAY_MS)
  fx.controller.onIdle("s1", [])
  await fx.advance(DELAY_MS)
  fx.controller.onIdle("s1", [])
  await fx.advance(DELAY_MS)
  expect(fx.sent.map((entry) => entry.sessionID)).toEqual(["s1", "s1", "s1"])
})

test("cooldown waits from the last nudge, not from the check that noticed it", async () => {
  const fx = fixture({ cooldownMs: 10_000 })
  fx.controller.start("s1", 60 * 60_000, true)
  await fx.advance(DELAY_MS)
  expect(fx.sent).toEqual([{ sessionID: "s1", at: START + DELAY_MS }])

  // The nudge turn ends three seconds after the send. The cooldown still ends ten
  // seconds after the send, so the next fire is seven seconds after this check.
  await fx.advance(3_000)
  fx.controller.onIdle("s1", [])
  await fx.advance(6_999)
  expect(fx.sent).toHaveLength(1)
  await fx.advance(1)
  expect(fx.sent).toEqual([
    { sessionID: "s1", at: START + DELAY_MS },
    { sessionID: "s1", at: START + DELAY_MS + 10_000 },
  ])
})

test("a user prompt during cooldown keeps the remaining cooldown", async () => {
  const fx = fixture({ cooldownMs: 10_000 })
  fx.controller.start("s1", 60 * 60_000, true)
  await fx.advance(DELAY_MS)
  await fx.advance(3_000)
  fx.controller.onIdle("s1", [])

  // User input at +5s cancels, and the next turn ends at +7s. The cooldown still
  // ends at the first send +10s, so the quiet window starts from +7s and only
  // extends the fire by the remaining quiet time.
  await fx.advance(2_000)
  fx.controller.onPrompt("s1", false)
  await fx.advance(2_000)
  fx.controller.onIdle("s1", [])
  await fx.advance(2_999)
  expect(fx.sent).toHaveLength(1)
  await fx.advance(1)
  expect(fx.sent).toHaveLength(2)
})

test("cooldown zero fires after the quiet window only", async () => {
  const fx = fixture({ cooldownMs: 0 })
  fx.controller.start("s1", 60 * 60_000, true)
  await fx.advance(DELAY_MS)
  fx.controller.onIdle("s1", [])
  await fx.advance(DELAY_MS - 1)
  expect(fx.sent).toHaveLength(1)
  await fx.advance(1)
  expect(fx.sent).toHaveLength(2)
})

test("cooldown longer than the remaining window expires without another nudge", async () => {
  const fx = fixture({ cooldownMs: 60_000 })
  fx.controller.start("s1", 10_000, true)
  await fx.advance(DELAY_MS)
  expect(fx.sent).toHaveLength(1)
  fx.controller.onIdle("s1", [])
  await fx.advance(60_000)
  expect(fx.controller.status("s1")).toMatchObject({ active: false, outcome: { reason: "expired" } })
  expect(fx.sent).toHaveLength(1)
})

test("deadline during cooldown expires the task", async () => {
  const fx = fixture({ cooldownMs: 60_000 })
  fx.controller.start("s1", 8_000, true)
  await fx.advance(DELAY_MS)
  expect(fx.sent).toHaveLength(1)
  fx.controller.onIdle("s1", [])
  await fx.advance(60_000)
  expect(fx.controller.status("s1").outcome?.reason).toBe("expired")
  expect(fx.sent).toHaveLength(1)
})

test("a failed send does not consume the cooldown and retries", async () => {
  const fx = fixture({ cooldownMs: 10_000 })
  fx.setSendError(new Error("send failed"))
  fx.controller.start("s1", 60 * 60_000, true)
  await fx.advance(DELAY_MS)
  expect(fx.sent).toHaveLength(0)
  expect(fx.errors).toHaveLength(1)
  expect(fx.controller.status("s1")).toMatchObject({ active: true, sentCount: 0 })
  fx.setSendError(undefined)
  await fx.advance(RECHECK_MS)
  await fx.advance(DELAY_MS)
  expect(fx.sent).toHaveLength(1)
  expect(fx.controller.status("s1")).toMatchObject({ sentCount: 1 })
})

test("live background work holds the nudge", async () => {
  const fx = fixture()
  fx.runWork("s1")
  fx.controller.start("s1", 60 * 60_000, true)
  await fx.advance(DELAY_MS)
  expect(fx.sent).toEqual([])
  fx.stopWork("s1")
  await fx.advance(RECHECK_MS)
  await fx.advance(DELAY_MS)
  expect(fx.sent.map((entry) => entry.sessionID)).toEqual(["s1"])
})

test("own idle background work holds until re-idle", async () => {
  const fx = fixture({ live: false })
  fx.controller.start("s1", 60 * 60_000, false)
  fx.controller.onIdle("s1", [own({ sessionID: "s1", shellID: "sh1" })])
  await fx.advance(DELAY_MS * 5)
  expect(fx.sent).toEqual([])
  fx.controller.onIdle("s1", [])
  await fx.advance(DELAY_MS)
  expect(fx.sent.map((entry) => entry.sessionID)).toEqual(["s1"])
})

test("descendant live work holds until the owner is quiet", async () => {
  const fx = fixture({ live: false })
  fx.busy("child1")
  fx.controller.start("s1", 60 * 60_000, false)
  fx.controller.onIdle("s1", [own({ sessionID: "child1", shellID: "sh1" })])
  await fx.advance(RECHECK_MS * 3)
  expect(fx.sent).toEqual([])
  fx.idle("child1")
  fx.controller.onIdle("child1", [])
  await fx.advance(RECHECK_MS)
  await fx.advance(DELAY_MS)
  expect(fx.sent.map((entry) => entry.sessionID)).toEqual(["s1"])
})

test("a work check error holds the nudge and retries", async () => {
  const fx = fixture()
  fx.setWorkError(new Error("work lookup failed"))
  fx.controller.start("s1", 60 * 60_000, true)
  await fx.advance(DELAY_MS)
  expect(fx.sent).toEqual([])
  expect(fx.errors.length).toBeGreaterThan(0)
  fx.setWorkError(undefined)
  await fx.advance(RECHECK_MS)
  await fx.advance(DELAY_MS)
  expect(fx.sent.map((entry) => entry.sessionID)).toEqual(["s1"])
})

test("a manual user interruption pauses until the next idle", async () => {
  const fx = fixture()
  fx.controller.start("s1", 60 * 60_000, true)
  await fx.advance(DELAY_MS)
  expect(fx.sent).toHaveLength(1)
  fx.controller.onAborted("s1", { type: "interrupted", reason: "user" })
  expect(fx.controller.status("s1")).toMatchObject({ active: true, phase: "paused" })
  await fx.advance(RECHECK_MS * 3)
  expect(fx.sent).toHaveLength(1)
  fx.controller.onIdle("s1", [])
  await fx.advance(DELAY_MS)
  expect(fx.sent).toHaveLength(2)
})

test("a system interruption resumes after recheck", async () => {
  const fx = fixture()
  fx.controller.start("s1", 60 * 60_000, true)
  await fx.advance(DELAY_MS)
  fx.busy("s1")
  await fx.advance(RECHECK_MS)
  fx.controller.onAborted("s1", { type: "interrupted", reason: "inactivity" })
  fx.idle("s1")
  await fx.advance(RECHECK_MS)
  await fx.advance(DELAY_MS)
  expect(fx.sent).toHaveLength(2)
})

test("a failed execution resumes after recheck", async () => {
  const fx = fixture()
  fx.busy("s1")
  fx.controller.start("s1", 60 * 60_000, false)
  await fx.advance(DELAY_MS)
  fx.controller.onAborted("s1", { type: "failed" })
  fx.idle("s1")
  await fx.advance(RECHECK_MS)
  await fx.advance(DELAY_MS)
  expect(fx.sent.map((entry) => entry.sessionID)).toEqual(["s1"])
})

test("a queued user message cancels and a cancellation rechecks", async () => {
  const fx = fixture()
  fx.controller.start("s1", 60 * 60_000, true)
  await fx.advance(1_000)
  fx.controller.onInboxEnqueued("s1", false)
  await fx.advance(DELAY_MS)
  expect(fx.sent).toEqual([])

  fx.controller.onInputCancelled("s1")
  await fx.advance(RECHECK_MS)
  await fx.advance(DELAY_MS)
  expect(fx.sent.map((entry) => entry.sessionID)).toEqual(["s1"])
})

test("a user prompt during the busy lookup cancels the send", async () => {
  const fx = fixture()
  const gate = deferred()
  fx.setBusyGate(gate.promise)
  fx.controller.start("s1", 60 * 60_000, true)
  await fx.advance(DELAY_MS)
  expect(fx.sent).toEqual([])
  fx.controller.onPrompt("s1", false)
  gate.resolve()
  await fx.flush()
  expect(fx.sent).toEqual([])
})

test("a stop during the busy lookup cancels the send", async () => {
  const fx = fixture()
  const gate = deferred()
  fx.setBusyGate(gate.promise)
  fx.controller.start("s1", 60 * 60_000, true)
  await fx.advance(DELAY_MS)
  fx.controller.stop("s1")
  gate.resolve()
  await fx.flush()
  expect(fx.sent).toEqual([])
  expect(fx.controller.status("s1")).toMatchObject({ active: false, outcome: { reason: "stopped" } })
})

test("a new start during the busy lookup does not let the old task send", async () => {
  const fx = fixture()
  const gate = deferred()
  fx.setBusyGate(gate.promise)
  fx.controller.start("s1", 60 * 60_000, true)
  await fx.advance(DELAY_MS)
  fx.controller.start("s1", 60 * 60_000, false)
  gate.resolve()
  await fx.flush()
  expect(fx.sent).toEqual([])
  expect(fx.controller.status("s1")).toMatchObject({ active: true, sentCount: 0 })
})

test("the deadline is rechecked after an await", async () => {
  const fx = fixture({ delayMs: 500 })
  const gate = deferred()
  fx.setBusyGate(gate.promise)
  fx.controller.start("s1", 1_500, true)
  await fx.advance(500)
  await fx.advance(1_500)
  gate.resolve()
  await fx.flush()
  expect(fx.sent).toEqual([])
  expect(fx.controller.status("s1")).toMatchObject({ active: false, outcome: { reason: "expired" } })
})

test("long deadlines are split into timer chunks", async () => {
  const fx = fixture()
  fx.controller.start("s1", 30 * DAY_MS, false)
  await fx.advance(MAX_TIMER_MS + 1)
  expect(fx.controller.status("s1").active).toBe(true)
  await fx.advance(30 * DAY_MS)
  expect(fx.controller.status("s1")).toMatchObject({ active: false, outcome: { reason: "expired" } })
})

test("status exposes cooldown, next nudge, and phase", async () => {
  const fx = fixture({ cooldownMs: 5_000 })
  fx.controller.start("s1", 60 * 60_000, true)
  expect(fx.controller.status("s1")).toMatchObject({
    active: true,
    cooldownMs: 5_000,
    phase: "quiet",
  })
  await fx.advance(DELAY_MS)
  const status = fx.controller.status("s1")
  expect(status).toMatchObject({ sentCount: 1, lastSentAt: START + DELAY_MS, cooldownUntil: START + DELAY_MS + 5_000 })
  expect(status.nextNudgeAt).toBeUndefined()
})

test("tasks are independent per session", async () => {
  const fx = fixture()
  fx.controller.start("s1", 60 * 60_000, true)
  fx.controller.start("s2", 60 * 60_000, true)
  await fx.advance(DELAY_MS)
  expect(fx.sent.map((entry) => entry.sessionID)).toEqual(["s1", "s2"])
  fx.controller.stop("s1")
  fx.controller.onIdle("s2", [])
  await fx.advance(DELAY_MS)
  expect(fx.sent.map((entry) => entry.sessionID)).toEqual(["s1", "s2", "s2"])
  expect(fx.controller.status("s1").active).toBe(false)
  expect(fx.controller.status("s2").active).toBe(true)
})

test("start replaces the task and resets counts and cooldown", async () => {
  const fx = fixture({ cooldownMs: 10_000 })
  fx.controller.start("s1", 60 * 60_000, true)
  await fx.advance(DELAY_MS)
  expect(fx.controller.status("s1")).toMatchObject({ active: true, sentCount: 1 })
  fx.controller.start("s1", 60 * 60_000, true, 0)
  expect(fx.controller.status("s1")).toMatchObject({ active: true, sentCount: 0, cooldownMs: 0 })
  await fx.advance(DELAY_MS)
  expect(fx.controller.status("s1")).toMatchObject({ sentCount: 1 })
})

test("stop reports the outcome and is idempotent", async () => {
  const fx = fixture()
  fx.controller.start("s1", 60 * 60_000, true)
  await fx.advance(1_000)
  fx.controller.stop("s1")
  expect(fx.controller.status("s1")).toMatchObject({ active: false, outcome: { reason: "stopped" } })
  fx.controller.stop("s1")
  expect(fx.controller.status("s1")).toMatchObject({ active: false, outcome: { reason: "stopped" } })
  await fx.advance(DELAY_MS * 2)
  expect(fx.sent).toEqual([])
})

test("activeStatuses lists only active tasks", async () => {
  const fx = fixture()
  fx.controller.start("s1", 60 * 60_000, true)
  fx.controller.start("s2", 60 * 60_000, true)
  fx.controller.stop("s1")
  expect(fx.controller.activeStatuses().map((entry) => entry.sessionID)).toEqual(["s2"])
})

test("expiry never sends while a turn is running", async () => {
  const fx = fixture()
  fx.controller.start("s1", 5_000, true)
  fx.busy("s1")
  await fx.advance(10_000)
  expect(fx.sent).toEqual([])
  expect(fx.controller.status("s1")).toMatchObject({ active: false, outcome: { reason: "expired" } })
})

test("isSessionBusy reads session time transitions", () => {
  expect(isSessionBusy(undefined)).toBe(false)
  expect(isSessionBusy({ time: {} })).toBe(false)
  expect(isSessionBusy({ time: { busy: 200 } })).toBe(true)
  expect(isSessionBusy({ time: { busy: 300, idle: 200 } })).toBe(true)
  expect(isSessionBusy({ time: { busy: 100, idle: 200 } })).toBe(false)
})
