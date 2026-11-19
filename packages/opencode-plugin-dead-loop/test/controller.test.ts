import { expect, test } from "bun:test"
import { DeadLoopController, isSessionBusy, type DeadLoopBackground, type DeadLoopStatus } from "../src/controller.js"

const START = 10_000
const DELAY_MS = 3_000
const RECHECK_MS = 15_000

type Fixture = {
  controller: DeadLoopController
  advance: (ms: number) => Promise<void>
  flush: () => Promise<void>
  sent: string[]
  busy: (sessionID: string) => void
  idle: (sessionID: string) => void
  busyCalls: string[]
  errors: unknown[]
  states: Array<{ sessionID: string; status: DeadLoopStatus }>
  now: () => number
}

function fixture(options: { delayMs?: number; recheckMs?: number } = {}): Fixture {
  let now = START
  let nextTimer = 0
  const timers = new Map<number, { at: number; run: () => void }>()
  const busySessions = new Set<string>()
  const sent: string[] = []
  const busyCalls: string[] = []
  const errors: unknown[] = []
  const states: Array<{ sessionID: string; status: DeadLoopStatus }> = []

  const controller = new DeadLoopController({
    delayMs: options.delayMs ?? DELAY_MS,
    recheckMs: options.recheckMs ?? RECHECK_MS,
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
      return busySessions.has(sessionID)
    },
    send: async (sessionID) => {
      sent.push(sessionID)
    },
    onError: (error) => {
      errors.push(error)
    },
    onState: (sessionID, status) => {
      states.push({ sessionID, status })
    },
  })

  const flush = async () => {
    for (let index = 0; index < 10; index++) await Promise.resolve()
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
  }
}

function own(work: { sessionID: string } & Record<string, unknown>): DeadLoopBackground {
  return { kind: "shell", ...work } as DeadLoopBackground
}

test("nudges once the quiet window elapses on an idle session", async () => {
  const fx = fixture()
  fx.controller.start("s1", 60 * 60_000, true)
  await fx.advance(DELAY_MS)
  expect(fx.sent).toEqual(["s1"])
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
  expect(fx.sent).toEqual(["s1"])
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

test("dead-loop nudges do not cancel pending windows", async () => {
  const fx = fixture()
  fx.controller.start("s1", 60 * 60_000, true)
  fx.controller.onPrompt("s1", true)
  await fx.advance(DELAY_MS)
  expect(fx.sent).toEqual(["s1"])
})

test("the loop repeats after each nudge turn completes", async () => {
  const fx = fixture()
  fx.controller.start("s1", 60 * 60_000, true)
  await fx.advance(DELAY_MS)
  fx.controller.onIdle("s1", [])
  await fx.advance(DELAY_MS)
  fx.controller.onIdle("s1", [])
  await fx.advance(DELAY_MS)
  expect(fx.sent).toEqual(["s1", "s1", "s1"])
})

test("own background work holds the nudge until the hook runs again", async () => {
  const fx = fixture()
  fx.controller.start("s1", 60 * 60_000, false)
  fx.controller.onIdle("s1", [own({ sessionID: "s1", shellID: "sh1" })])
  await fx.advance(DELAY_MS * 5)
  expect(fx.sent).toEqual([])
  fx.controller.onIdle("s1", [])
  await fx.advance(DELAY_MS)
  expect(fx.sent).toEqual(["s1"])
})

test("descendant background work holds the loop until the owners are quiet", async () => {
  const fx = fixture()
  fx.busy("child1")
  fx.controller.start("s1", 60 * 60_000, false)
  fx.controller.onIdle("s1", [
    own({ sessionID: "child1", shellID: "sh1" }),
    own({ sessionID: "child2", kind: "subagent", childSessionID: "c2" }),
  ])
  await fx.advance(RECHECK_MS)
  expect(fx.sent).toEqual([])
  fx.idle("child1")
  fx.controller.onIdle("child1", [])
  await fx.advance(RECHECK_MS)
  expect(fx.sent).toEqual([])
  fx.controller.onIdle("child2", [])
  await fx.advance(RECHECK_MS)
  await fx.advance(DELAY_MS)
  expect(fx.sent).toEqual(["s1"])
})

test("a running subagent child never clears the hold until it re-idles", async () => {
  const fx = fixture()
  fx.busy("child1")
  fx.controller.start("s1", 60 * 60_000, false)
  fx.controller.onIdle("s1", [own({ sessionID: "child1", kind: "subagent", childSessionID: "child1" })])
  // While the child keeps working, every recheck holds.
  await fx.advance(RECHECK_MS * 3)
  expect(fx.sent).toEqual([])
  // The child finishing its work re-idles through its own hook and clears the hold.
  fx.idle("child1")
  fx.controller.onIdle("child1", [])
  await fx.advance(RECHECK_MS)
  await fx.advance(DELAY_MS)
  expect(fx.sent).toEqual(["s1"])
})

test("a descendant background entry holds until its owner re-idles", async () => {
  const fx = fixture()
  fx.controller.start("s1", 60 * 60_000, false)
  fx.controller.onIdle("s1", [own({ sessionID: "child1", shellID: "sh1" })])
  await fx.advance(RECHECK_MS * 2)
  expect(fx.sent).toEqual([])
  fx.controller.onIdle("child1", [])
  await fx.advance(RECHECK_MS)
  await fx.advance(DELAY_MS)
  expect(fx.sent).toEqual(["s1"])
})

test("expiry stops the loop without interrupting a running turn", async () => {
  const fx = fixture()
  fx.controller.start("s1", 10_000, true)
  await fx.advance(DELAY_MS)
  expect(fx.sent).toEqual(["s1"])
  // The nudge turn is running when the next window would fire: no interrupt, no send.
  fx.busy("s1")
  await fx.advance(DELAY_MS)
  expect(fx.sent).toEqual(["s1"])
  fx.idle("s1")
  fx.controller.onIdle("s1", [])
  await fx.advance(DELAY_MS)
  expect(fx.sent).toEqual(["s1", "s1"])
  // From here the deadline passes before the following window can fire.
  fx.controller.onIdle("s1", [])
  await fx.advance(DELAY_MS * 10)
  expect(fx.controller.status("s1")).toMatchObject({ active: false, outcome: { reason: "expired" } })
  expect(fx.sent).toEqual(["s1", "s1"])
})

test("a pending quiet window that elapses after the deadline expires the task", async () => {
  const fx = fixture()
  fx.controller.start("s1", 5_000, true)
  await fx.advance(DELAY_MS)
  expect(fx.sent).toEqual(["s1"])
  fx.controller.onIdle("s1", [])
  await fx.advance(60_000)
  expect(fx.controller.status("s1")).toMatchObject({ active: false, outcome: { reason: "expired" } })
  expect(fx.sent).toEqual(["s1"])
})

test("stop cancels pending timers and reports the outcome", async () => {
  const fx = fixture()
  fx.controller.start("s1", 60 * 60_000, true)
  await fx.advance(1_000)
  fx.controller.stop("s1")
  expect(fx.controller.status("s1")).toMatchObject({ active: false, outcome: { reason: "stopped" } })
  await fx.advance(DELAY_MS * 5)
  expect(fx.sent).toEqual([])
})

test("start while running replaces the task with a fresh window", async () => {
  const fx = fixture()
  fx.controller.start("s1", 60 * 60_000, true)
  await fx.advance(DELAY_MS)
  expect(fx.controller.status("s1")).toMatchObject({ active: true, sentCount: 1 })
  fx.controller.start("s1", 60 * 60_000, true)
  expect(fx.controller.status("s1")).toMatchObject({ active: true, sentCount: 0, startedAt: START + DELAY_MS })
})

test("a busy session at fire time skips the nudge and waits for the next idle", async () => {
  const fx = fixture()
  fx.controller.start("s1", 60 * 60_000, true)
  await fx.advance(1_000)
  fx.busy("s1")
  await fx.advance(DELAY_MS)
  expect(fx.sent).toEqual([])
  fx.idle("s1")
  fx.controller.onIdle("s1", [])
  await fx.advance(DELAY_MS)
  expect(fx.sent).toEqual(["s1"])
})

test("start while an own background shell runs holds and rechecks", async () => {
  const fx = fixture()
  fx.controller.onIdle("s0", [own({ sessionID: "s0", shellID: "sh_old" })])
  fx.controller.start("s0", 60 * 60_000, true)
  await fx.advance(DELAY_MS)
  expect(fx.sent).toEqual([])
  fx.controller.onIdle("s0", [])
  await fx.advance(RECHECK_MS)
  await fx.advance(DELAY_MS)
  expect(fx.sent).toEqual(["s0"])
})

test("task state is per session", async () => {
  const fx = fixture()
  fx.controller.start("s1", 60 * 60_000, true)
  fx.controller.start("s2", 60 * 60_000, true)
  await fx.advance(DELAY_MS)
  expect(fx.sent).toEqual(["s1", "s2"])
  fx.controller.stop("s1")
  fx.controller.onIdle("s2", [])
  await fx.advance(DELAY_MS)
  expect(fx.sent).toEqual(["s1", "s2", "s2"])
  expect(fx.controller.status("s1").active).toBe(false)
  expect(fx.controller.status("s2").active).toBe(true)
})

test("send failures are reported and do not crash the loop", async () => {
  let now = START
  let nextTimer = 0
  const timers = new Map<number, { at: number; run: () => void }>()
  const errors: unknown[] = []
  let sends = 0
  const controller = new DeadLoopController({
    delayMs: DELAY_MS,
    recheckMs: RECHECK_MS,
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
    isBusy: async () => false,
    send: async () => {
      sends += 1
      throw new Error("send failed")
    },
    onError: (error) => {
      errors.push(error)
    },
  })
  controller.start("s1", 60 * 60_000, true)
  for (let index = 0; index < 10; index++) await Promise.resolve()
  const timer = [...timers.values()][0]
  now = timer.at
  timers.delete([...timers.keys()][0])
  timer.run()
  for (let index = 0; index < 10; index++) await Promise.resolve()
  expect(sends).toBe(1)
  expect(errors).toHaveLength(1)
  expect(controller.status("s1")).toMatchObject({ active: true, sentCount: 0 })
})

test("isSessionBusy reads session time transitions", () => {
  expect(isSessionBusy(undefined)).toBe(false)
  expect(isSessionBusy({ time: {} })).toBe(false)
  expect(isSessionBusy({ time: { busy: 200 } })).toBe(true)
  expect(isSessionBusy({ time: { busy: 300, idle: 200 } })).toBe(true)
  expect(isSessionBusy({ time: { busy: 100, idle: 200 } })).toBe(false)
})
