import type { Context } from "@opencode/plugin/tui/context"
import type { Renderable, ScrollBoxRenderable } from "@opentui/core"
import type { Entry, Message } from "./search.js"

export type Anchor = { align(): void }
export type NavigationHost = {
  session(): string | undefined
  commands(): readonly string[]
  dispatch(command: string): void
  loaded(messageID: string): boolean
  reverted(messageID: string): boolean
  find(entry: Pick<Entry, "messageID" | "ordinal">): Anchor | undefined
  frame(signal: AbortSignal): Promise<void>
}

export function textOwnsBoundary(message: Message | undefined, ordinal: number) {
  if (message?.type !== "assistant") return false
  let index = 0
  for (const part of message.content ?? []) {
    if (part.type === "text") {
      const current = index++
      if (!part.text?.trim()) continue
      return current === ordinal
    }
    if (part.type === "tool" || part.text?.trim()) return false
  }
  return false
}

export class SessionNavigator {
  private request: AbortController | undefined
  constructor(private host: NavigationHost, private changed: (busy: boolean) => void = () => {}, private timeout = 30_000) {}
  cancel() { this.request?.abort(); this.request = undefined; this.changed(false) }
  async jump(sessionID: string, entry: Pick<Entry, "messageID" | "ordinal">) {
    this.cancel()
    const request = new AbortController()
    this.request = request
    this.changed(true)
    let hostPending = false
    const cancelHost = () => {
      if (!hostPending || this.request !== request || this.host.session() !== sessionID) return
      try {
        if (this.host.commands().includes("session.line.up")) {
          hostPending = false
          this.host.dispatch("session.line.up")
        }
      } catch { /* The route may already be disposing; never touch a replacement session. */ }
    }
    request.signal.addEventListener("abort", cancelHost, { once: true })
    const deadline = Date.now() + this.timeout
    const check = () => {
      request.signal.throwIfAborted()
      if (this.host.session() !== sessionID) throw new Error("Session changed; navigation cancelled")
      if (this.host.reverted(entry.messageID)) throw new Error("This message is currently reverted and cannot be shown")
      if (Date.now() >= deadline) throw new Error("Could not locate this message; history may have changed")
    }
    const requireCommand = (id: string) => {
      if (!this.host.commands().includes(id)) throw new Error(`This OpenCode version does not expose ${id}`)
    }
    const wait = async (ready: () => boolean) => {
      while (true) { check(); if (ready()) return; await this.host.frame(request.signal) }
    }
    try {
      check()
      await this.host.frame(request.signal)
      check()
      requireCommand("session.line.up")
      if (!this.host.find(entry)) {
        requireCommand("session.message.next")
        if (!this.host.loaded(entry.messageID)) {
          requireCommand("session.first")
          hostPending = true
          this.host.dispatch("session.first")
          await wait(() => this.host.loaded(entry.messageID))
          await this.host.frame(request.signal)
        }
        check()
        hostPending = true
        this.host.dispatch("session.message.next")
        await wait(() => Boolean(this.host.find(entry)))
        // Clear the host's previous/next-message cursor before positioning another message.
        this.host.dispatch("session.line.up")
        hostPending = false
        await this.host.frame(request.signal)
      } else {
        // A previous built-in timeline jump can leave a cursor even when this target is mounted.
        this.host.dispatch("session.line.up")
        await this.host.frame(request.signal)
      }
      check()
      const anchor = this.host.find(entry)
      if (!anchor) throw new Error("Message is no longer mounted")
      anchor.align()
      await this.host.frame(request.signal)
      check()
      const settled = this.host.find(entry)
      if (!settled) throw new Error("Message changed during navigation")
      settled.align()
    } finally {
      cancelHost()
      request.signal.removeEventListener("abort", cancelHost)
      if (this.request === request) { this.request = undefined; this.changed(false) }
    }
  }
}

export function rendererFrame(renderer: Pick<Context["renderer"], "once" | "off" | "requestRender" | "root">, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(signal.reason); return }
    if (renderer.root.isDestroyed) { reject(new Error("TUI was closed")); return }
    const finish = (error?: unknown) => {
      clearTimeout(timer)
      clearTimeout(schedule)
      renderer.off("frame", ready)
      signal.removeEventListener("abort", abort)
      error === undefined ? resolve() : reject(error)
    }
    const ready = () => finish()
    const abort = () => finish(signal.reason)
    const timer = setTimeout(() => finish(new Error("TUI layout did not become ready")), 3_000)
    // A frame event can precede scheduler cleanup. Request the next frame in a new task.
    const schedule = setTimeout(() => {
      if (renderer.root.isDestroyed) { finish(new Error("TUI was closed")); return }
      renderer.once("frame", ready)
      try { renderer.requestRender() } catch (error) { finish(error) }
    }, 0)
    signal.addEventListener("abort", abort, { once: true })
  })
}

export function navigationHost(context: Context): NavigationHost {
  const session = () => { const route = context.ui.router.current(); return route.type === "session" ? route.sessionID : undefined }
  const visible = (node: Renderable) => {
    for (let current: Renderable | null = node; current; current = current.parent as Renderable | null) {
      if (!current.visible || current.isDestroyed) return false
    }
    return true
  }
  const find = (id: string) => {
    const first = context.renderer.root.findDescendantById(id) as Renderable | undefined
    if (!first) return
    if (visible(first)) return first
    // Forked transcripts can share message IDs; never target a hidden tab's copy.
    const visit = (node: Renderable): Renderable | undefined => {
      if (!node.visible || node.isDestroyed) return
      if (node.id === id) return node
      for (const child of node.getChildren()) { const found = visit(child); if (found) return found }
    }
    return visit(context.renderer.root)
  }
  return {
    session,
    commands: () => context.keymap.commands().flatMap((command) => command.id ? [command.id] : []),
    dispatch: (id) => context.keymap.dispatch(id),
    loaded: (id) => Boolean(session() && context.data.session.message.get(session()!, id)),
    reverted: (id) => { const boundary = session() && context.data.session.get(session()!)?.revert?.messageID; return Boolean(boundary && id >= boundary) },
    frame: async (signal) => { await rendererFrame(context.renderer, signal); await rendererFrame(context.renderer, signal) },
    find: (entry) => {
      // These host anchors are verified by real TUI tests; unavailable anchors fail safely.
      const part = entry.ordinal === undefined ? undefined : find(`session-part:${entry.messageID}:text:${entry.ordinal}`)
      const boundaryAllowed = entry.ordinal === undefined || textOwnsBoundary(context.data.session.message.get(session()!, entry.messageID), entry.ordinal)
      const node = (part ?? (boundaryAllowed ? find(entry.messageID) : undefined)) as Renderable | undefined
      if (!node || node.isDestroyed || node.height <= 0) return
      let parent = node.parent as Renderable | null
      while (parent && !("scrollTo" in parent && "viewport" in parent)) parent = parent.parent as Renderable | null
      const scroll = parent as ScrollBoxRenderable | null
      if (!scroll || scroll.isDestroyed || scroll.viewport.height <= 0) return
      return { align() {
        if (node.isDestroyed || scroll.isDestroyed) return
        scroll.stickyScroll = false
        scroll.scrollTo(Math.max(0, scroll.scrollTop + node.y - scroll.viewport.y))
      } }
    },
  }
}
