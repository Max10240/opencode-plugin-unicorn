import { expect, test } from "bun:test"
import { SessionSearchController, type Page, type Source } from "../src/controller.js"

test("loads every cursor with bounded concurrency and reuses unchanged complete history", async () => {
  const calls: string[] = []
  let active = 0
  let maximum = 0
  const source: Source = {
    info: async () => ({ time: { updated: 1 } }),
    page: async (sessionID, type, cursor) => {
      calls.push(`${sessionID}:${type}:${cursor ?? "first"}`)
      active++; maximum = Math.max(maximum, active); await Bun.sleep(1); active--
      return { data: type === "compaction" ? [] : [{ id: `${type}-${cursor ?? "first"}`, type, text: "user", content: [{ type: "text", text: "agent" }] }], cursor: { next: cursor || type === "compaction" ? undefined : "older" } }
    },
  }
  const controller = new SessionSearchController(source, () => {})
  await controller.open("only-current")
  expect(controller.index.size).toBe(4)
  expect(maximum).toBe(2)
  expect(calls).toHaveLength(5)
  await controller.open("only-current")
  expect(calls).toHaveLength(5)
  controller.invalidate()
  await controller.open("only-current")
  expect(calls).toHaveLength(10)
  expect(controller.loading).toBe(false)
  expect(controller.ready).toBe(true)
  controller.invalidate(true)
  expect(controller.ready).toBe(false)
})

test("late responses from a different session cannot publish or pollute the active index", async () => {
  let release!: (page: Page) => void
  const pending = new Promise<Page>((resolve) => { release = resolve })
  const source: Source = {
    info: async () => ({ time: { updated: 1 } }),
    page: async (sessionID, type) => sessionID === "old" ? pending : ({ data: type === "user" ? [{ id: "new", type, text: "new session" }] : [], cursor: {} }),
  }
  const controller = new SessionSearchController(source, () => {})
  const old = controller.open("old")
  await Bun.sleep(0)
  await controller.open("new")
  release({ data: [{ id: "old", type: "user", text: "PRIVATE_OLD_SESSION" }], cursor: {} })
  await old
  expect(controller.sessionID).toBe("new")
  expect((await controller.index.search("PRIVATE")).total).toBe(0)
  expect(controller.index.size).toBe(1)
})

test("owner cancellation stops loading, and an old dialog cannot cancel a newer one", async () => {
  const owners = [new AbortController(), new AbortController()]
  let releases: Array<() => void> = []
  const source: Source = { info: async () => ({ time: { updated: 1 } }), page: async () => {
    await new Promise<void>((resolve) => releases.push(resolve))
    return { data: [], cursor: {} }
  } }
  const controller = new SessionSearchController(source, () => {})
  const first = controller.open("same", owners[0].signal)
  await Bun.sleep(0)
  const second = controller.open("same", owners[1].signal)
  await Bun.sleep(0)
  owners[0].abort()
  expect(controller.loading).toBe(true)
  owners[1].abort()
  expect(controller.loading).toBe(false)
  // Release requests even when the deliberately non-cooperative fake transport ignores aborts.
  for (let i = 0; i < 3; i++) { const current = releases; releases = []; current.forEach((release) => release()); await Bun.sleep(0) }
  await Promise.all([first, second])
})

test("invalid cursors and request failures clear cached text instead of showing stale results", async () => {
  let fail = false
  const source: Source = { info: async () => ({ time: { updated: fail ? 2 : 1 } }), page: async (_sessionID, type) => {
    if (fail) throw new Error("session unavailable")
    return { data: type === "user" ? [{ id: "u", type, text: "old" }] : [], cursor: {} }
  } }
  const controller = new SessionSearchController(source, () => {})
  await controller.open("s")
  fail = true
  await controller.open("s")
  expect(controller.error).toBe("session unavailable")
  expect(controller.index.size).toBe(0)
  expect(controller.ready).toBe(false)
  fail = false
  source.page = async () => ({ data: [], cursor: { next: "same-cursor" } })
  await controller.open("s")
  expect(controller.error).toContain("Repeated history cursor")
  controller.dispose()
  expect(controller.sessionID).toBeUndefined()
})
