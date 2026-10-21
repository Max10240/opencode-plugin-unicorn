import { expect, test } from "bun:test"
import { EventEmitter } from "node:events"
import { navigationHost, rendererFrame, SessionNavigator, textOwnsBoundary, type NavigationHost } from "../src/navigation.js"

function fixture() {
  let session = "current"
  let loaded = false
  let mounted = false
  let aligned = 0
  const calls: string[] = []
  const host: NavigationHost = {
    session: () => session, commands: () => ["session.first", "session.message.next", "session.line.up"],
    loaded: () => loaded, reverted: () => false,
    find: () => mounted ? { align() { aligned++ } } : undefined,
    frame: async (signal) => { signal.throwIfAborted(); await Promise.resolve() },
    dispatch(id) { calls.push(id); if (id === "session.first") loaded = true; if (id === "session.message.next") mounted = true },
  }
  return { host, calls, aligned: () => aligned, mount: () => { mounted = true }, switchSession: () => { session = "other" } }
}

test("assistant text anchors do not accidentally land on a preceding reasoning/tool group", () => {
  expect(textOwnsBoundary({ id: "a", type: "assistant", content: [{ type: "text", text: "" }, { type: "text", text: "first visible" }] }, 1)).toBe(true)
  expect(textOwnsBoundary({ id: "a", type: "assistant", content: [{ type: "reasoning", text: "hidden thoughts" }, { type: "text", text: "answer" }] }, 0)).toBe(false)
  expect(textOwnsBoundary({ id: "a", type: "assistant", content: [{ type: "tool" }, { type: "text", text: "answer" }] }, 0)).toBe(false)
  expect(textOwnsBoundary({ id: "a", type: "assistant", content: [{ type: "text", text: "first" }, { type: "text", text: "second" }] }, 1)).toBe(false)
})

test("unloaded targets use a bounded number of host commands and clear the host cursor before alignment", async () => {
  const current = fixture()
  await new SessionNavigator(current.host).jump("current", { messageID: "old-agent-message" })
  expect(current.calls).toEqual(["session.first", "session.message.next", "session.line.up"])
  expect(current.aligned()).toBe(2)
})

test("already mounted targets clear an old host cursor without loading or walking all history", async () => {
  const current = fixture(); current.mount()
  await new SessionNavigator(current.host).jump("current", { messageID: "visible" })
  expect(current.calls).toEqual(["session.line.up"])
  expect(current.aligned()).toBe(2)
})

test("renderer navigation ignores hidden duplicate anchors and uses live scroll geometry", () => {
  let top = -1
  const scroll: any = { visible: true, isDestroyed: false, parent: null, scrollTop: 20, viewport: { y: 3, height: 30 }, stickyScroll: true, scrollTo(value: number) { top = value }, getChildren: () => [visible] }
  const hidden: any = { id: "target", visible: false, isDestroyed: false, height: 5, y: 200, parent: null, getChildren: () => [] }
  const visible: any = { id: "target", visible: true, isDestroyed: false, height: 5, y: 14, parent: scroll, getChildren: () => [] }
  const root: any = { id: "root", visible: true, isDestroyed: false, parent: null, findDescendantById: (id: string) => id === "target" ? hidden : undefined, getChildren: () => [hidden, scroll] }
  scroll.parent = root
  const context: any = { renderer: { root }, ui: { router: { current: () => ({ type: "session", sessionID: "s" }) } }, data: { session: { get: () => ({}), message: { get: () => ({ id: "target", type: "user" }) } } }, keymap: { commands: () => [], dispatch() {} } }
  const anchor = navigationHost(context).find({ messageID: "target" })
  expect(anchor).toBeDefined()
  anchor!.align()
  expect(top).toBe(31)
  expect(scroll.stickyScroll).toBe(false)
  scroll.visible = false
  expect(navigationHost(context).find({ messageID: "target" })).toBeUndefined()
})

test("session changes, reverted messages and unsupported hosts cannot jump to the wrong content", async () => {
  const current = fixture()
  current.host.frame = async () => current.switchSession()
  await expect(new SessionNavigator(current.host).jump("current", { messageID: "target" })).rejects.toThrow("Session changed")
  expect(current.aligned()).toBe(0)
  const reverted = fixture(); reverted.host.reverted = () => true
  await expect(new SessionNavigator(reverted.host).jump("current", { messageID: "target" })).rejects.toThrow("reverted")
  const unsupported = fixture(); unsupported.host.commands = () => []
  await expect(new SessionNavigator(unsupported.host).jump("current", { messageID: "target" })).rejects.toThrow("does not expose")
  expect(unsupported.calls).toEqual([])
})

test("cancellation and missing anchors settle instead of leaving navigation active", async () => {
  const current = fixture()
  current.host.frame = async (signal) => { await Bun.sleep(1); signal.throwIfAborted() }
  let busy = false
  const navigator = new SessionNavigator(current.host, (value) => { busy = value })
  const pending = navigator.jump("current", { messageID: "target" })
  navigator.cancel()
  await expect(pending).rejects.toThrow()
  expect(busy).toBe(false)
  current.host.loaded = () => true; current.host.find = () => undefined
  await expect(new SessionNavigator(current.host, () => {}, 5).jump("current", { messageID: "missing" })).rejects.toThrow("history may have changed")
  expect(current.calls).toContain("session.line.up")
})

test("cancelling an in-flight host history load dispatches its cancel command only in the owning session", async () => {
  for (const switched of [false, true]) {
    const current = fixture()
    current.host.dispatch = (id) => { current.calls.push(id) }
    current.host.frame = async (signal) => { await Bun.sleep(1); signal.throwIfAborted() }
    const navigator = new SessionNavigator(current.host)
    const pending = navigator.jump("current", { messageID: "older" })
    while (!current.calls.length) await Bun.sleep(1)
    if (switched) current.switchSession()
    navigator.cancel()
    await expect(pending).rejects.toThrow()
    expect(current.calls).toEqual(switched ? ["session.first"] : ["session.first", "session.line.up"])
  }
})

test("renderer layout listeners are cleaned on completion, abort and render failure", async () => {
  const events = new EventEmitter()
  const renderer = Object.assign(events, { root: { isDestroyed: false }, requestRender() { events.emit("frame") } })
  await rendererFrame(renderer as any, new AbortController().signal)
  expect(renderer.listenerCount("frame")).toBe(0)
  renderer.requestRender = () => {}
  const request = new AbortController()
  const waiting = rendererFrame(renderer as any, request.signal)
  request.abort()
  await expect(waiting).rejects.toThrow()
  expect(renderer.listenerCount("frame")).toBe(0)
  const active = new AbortController()
  const activeWait = rendererFrame(renderer as any, active.signal)
  await Bun.sleep(5)
  expect(renderer.listenerCount("frame")).toBe(1)
  active.abort()
  await expect(activeWait).rejects.toThrow()
  expect(renderer.listenerCount("frame")).toBe(0)
  renderer.requestRender = () => { throw new Error("renderer stopped") }
  await expect(rendererFrame(renderer as any, new AbortController().signal)).rejects.toThrow("renderer stopped")
  expect(renderer.listenerCount("frame")).toBe(0)
})

test("consecutive frame waits request rendering after the previous scheduler task settles", async () => {
  const events = new EventEmitter()
  let scheduled = false
  let frames = 0
  const renderer = Object.assign(events, { root: { isDestroyed: false }, requestRender() {
    if (scheduled) return
    scheduled = true
    setTimeout(async () => {
      frames++
      events.emit("frame")
      await Promise.resolve()
      scheduled = false
    }, 0)
  } })
  const request = new AbortController()
  await rendererFrame(renderer as any, request.signal)
  await rendererFrame(renderer as any, request.signal)
  expect(frames).toBe(2)
  expect(events.listenerCount("frame")).toBe(0)
})
