import { expect, test } from "bun:test"
import { SessionTracker } from "../src/tracker.js"

function listContext(rows: Array<Record<string, unknown>>) {
  return {
    session: {
      list: async () => ({ data: rows as any[], cursor: {} }),
    },
  }
}

test("seeds the session tree and statuses from the session list", async () => {
  const tracker = new SessionTracker()
  await tracker.seed(
    listContext([
      { id: "root", title: "Root", location: { directory: "/root" }, time: { created: 1, updated: 2, busy: 3, idle: 2 } },
      { id: "child", parentID: "root", title: "Child", location: { directory: "/root" }, time: { created: 2, updated: 3, busy: 4, idle: 3 } },
    ]),
  )
  expect(tracker.statusOf("root")).toBe("running")
  expect(tracker.statusOf("child")).toBe("running")
  expect(tracker.family("root")).toEqual(new Set(["root", "child"]))
  expect(tracker.hasRunningWork("root")).toBe(true)
  expect(tracker.info("child")).toEqual({ title: "Child", directory: "/root" })
})

test("session events update the tree and busy state", () => {
  const tracker = new SessionTracker()
  tracker.handle({ type: "session.created", created: 10, data: { sessionID: "root", title: "Root", location: { directory: "/root" } } })
  tracker.handle({ type: "session.created", created: 11, data: { sessionID: "child", parentID: "root", title: "Child" } })
  expect(tracker.family("root")).toEqual(new Set(["root", "child"]))
  tracker.handle({ type: "session.execution.started", created: 12, data: { sessionID: "child" } })
  expect(tracker.hasRunningWork("root")).toBe(true)
  tracker.handle({ type: "session.execution.succeeded", created: 13, data: { sessionID: "child" } })
  expect(tracker.hasRunningWork("root")).toBe(false)
  tracker.handle({ type: "session.renamed", created: 14, data: { sessionID: "child", title: "Renamed" } })
  expect(tracker.info("child").title).toBe("Renamed")
  tracker.handle({ type: "session.moved", created: 15, data: { sessionID: "child", location: { directory: "/moved" } } })
  expect(tracker.info("child").directory).toBe("/moved")
  tracker.handle({ type: "session.deleted", created: 16, data: { sessionID: "child" } })
  expect(tracker.family("root")).toEqual(new Set(["root"]))
})

test("pending input blocks until the execution starts or the item is cancelled", () => {
  const tracker = new SessionTracker()
  tracker.onInboxEnqueued("s1", false, 1)
  expect(tracker.isBusy("s1")).toBe(true)
  tracker.onExecutionStarted("s1", 2)
  expect(tracker.isBusy("s1")).toBe(true)
  tracker.onExecutionEnded("s1", 3)
  expect(tracker.isBusy("s1")).toBe(false)

  tracker.onInboxEnqueued("s1", false, 4)
  tracker.onInboxCancelled("s1", 5)
  expect(tracker.isBusy("s1")).toBe(false)
})

test("own prompts do not mark the session busy", () => {
  const tracker = new SessionTracker()
  tracker.onPrompt("s1", true, 1)
  expect(tracker.isBusy("s1")).toBe(false)
})

test("shell events block the owner family and survive a deleted owner", () => {
  const tracker = new SessionTracker()
  tracker.handle({ type: "session.created", created: 1, data: { sessionID: "root" } })
  tracker.handle({ type: "session.created", created: 2, data: { sessionID: "child", parentID: "root" } })
  tracker.handle({
    type: "shell.created",
    created: 3,
    data: { info: { id: "sh1", status: "running", metadata: { sessionID: "child" } } },
  })
  expect(tracker.hasRunningWork("root")).toBe(true)
  tracker.handle({ type: "session.deleted", created: 4, data: { sessionID: "child" } })
  expect(tracker.hasRunningWork("root")).toBe(true)
  tracker.handle({ type: "shell.exited", created: 5, data: { id: "sh1" } })
  expect(tracker.hasRunningWork("root")).toBe(false)
})

test("idle reconciliation clears a missed shell exit", () => {
  const tracker = new SessionTracker()
  tracker.handle({ type: "session.created", created: 1, data: { sessionID: "s1" } })
  tracker.handle({
    type: "shell.created",
    created: 2,
    data: { info: { id: "sh1", status: "running", metadata: { sessionID: "s1" } } },
  })
  expect(tracker.hasRunningWork("s1")).toBe(true)
  tracker.onIdle("s1", [], 3)
  expect(tracker.hasRunningWork("s1")).toBe(false)
})

test("idle background entries seed child work and images", () => {
  const tracker = new SessionTracker()
  tracker.handle({ type: "session.created", created: 1, data: { sessionID: "root" } })
  tracker.onIdle(
    "root",
    [
      { sessionID: "child", kind: "subagent" },
      { sessionID: "child", kind: "shell", shellID: "sh1" },
      { sessionID: "root", kind: "image", path: "/tmp/a.png" },
    ],
    2,
  )
  expect(tracker.family("root")).toEqual(new Set(["root", "child"]))
  expect(tracker.hasRunningWork("root")).toBe(true)

  // A parent's empty snapshot clears its own image, but not a descendant's running
  // subagent/shell: the child's own execution events own that state.
  tracker.onIdle("root", [], 3)
  expect(tracker.hasRunningWork("root")).toBe(true)
  tracker.onExecutionEnded("child", 4)
  tracker.handle({ type: "shell.exited", created: 5, data: { id: "sh1" } })
  expect(tracker.hasRunningWork("root")).toBe(false)
})

test("seed returns promptly when the session list never resolves", async () => {
  const tracker = new SessionTracker()
  const started = Date.now()
  await tracker.seed({ session: { list: () => new Promise(() => {}) } }, 30)
  expect(Date.now() - started).toBeLessThan(1_000)
  expect(tracker.statusOf("s1")).toBeUndefined()
})

test("remember merges a session row fetched outside the event stream", () => {
  const tracker = new SessionTracker()
  tracker.remember({ id: "s1", title: "Main", location: { directory: "/work" }, time: { created: 1, updated: 2 } })
  expect(tracker.info("s1")).toEqual({ title: "Main", directory: "/work" })
  expect(tracker.statusOf("s1")).toBe("idle")
})

test("a forced reconnect seed removes sessions deleted during the gap", async () => {
  let rows: Array<Record<string, unknown>> = [
    { id: "root", title: "Root", time: { created: 1, updated: 2 } },
    { id: "child", parentID: "root", title: "Child", time: { created: 2, updated: 3 } },
  ]
  const tracker = new SessionTracker()
  const context = { session: { list: async () => ({ data: rows as any[], cursor: {} }) } }
  await tracker.seed(context)
  expect(tracker.family("root")).toEqual(new Set(["root", "child"]))

  rows = [{ id: "root", title: "Root", time: { created: 1, updated: 2 } }]
  await tracker.seed(context, 2_000, true)
  expect(tracker.family("root")).toEqual(new Set(["root"]))
  expect(tracker.statusOf("child")).toBeUndefined()
})
