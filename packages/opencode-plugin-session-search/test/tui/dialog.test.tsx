/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { InputRenderable, type Renderable } from "@opentui/core"
import { testRender } from "@opentui/solid"
import type { Context } from "@opencode/plugin/tui/context"
import { createSignal } from "solid-js"
import { SessionSearchDialog } from "../../src/dialog.js"
import type { SessionSearchController } from "../../src/controller.js"
import type { SessionNavigator } from "../../src/navigation.js"
import { TranscriptIndex } from "../../src/search.js"

const theme = {
  text: { base: "#ffffff", muted: "#aaaaaa", formfield: { base: "#ffffff" }, feedback: { success: { base: "#00ff00" }, error: { base: "#ff0000" } } },
  background: { raised: { high: "#333333" } },
  border: { base: "#444444" },
  formfield: { base: "#ffffff" },
  surface: () => theme,
}

function createHarness(options: { copy?: boolean; noticeDuration?: number; userText?: string; jumpFails?: boolean; onFailure?: (message: string) => void; defaultIncludeAgent?: boolean; storedIncludeAgent?: boolean } = {}) {
  const clipboard: string[] = []
  const jumps: string[] = []
  const updates: Array<{ includeAgent: boolean }> = []
  const stored = { includeAgent: options.storedIncludeAgent ?? options.defaultIncludeAgent === true }
  const layers: Array<{ commands: Array<{ bind?: string; title?: string; run: () => void }> }> = []
  const index = new TranscriptIndex()
  const now = Date.now()
  index.upsert({ id: "u1", type: "user", time: { created: now - 60_000 }, text: options.userText ?? "user message one" })
  index.upsert({ id: "a1", type: "assistant", time: { created: now - 120_000 }, agent: "build", content: [{ type: "text", text: "agent message one" }] })
  index.upsert({ id: "u2", type: "user", time: { created: now - 180_000 }, text: "second user message" })
  const controller = { index, ready: true, loading: false, error: undefined, open: async () => {} } as unknown as SessionSearchController
  const navigator = { jump: async (_sessionID: string, entry: { text: string }) => { if (options.jumpFails) throw new Error("exact part did not render"); jumps.push(entry.text) }, cancel() {} } as unknown as SessionNavigator
  const [revision] = createSignal(0)
  const context = {
    options: options.defaultIncludeAgent === true ? { defaultIncludeAgent: true } : {},
    theme,
    renderer: { copyToClipboardOSC52: (text: string) => { if (options.copy === false) return false; clipboard.push(text); return true } },
    keymap: { layer: (factory: () => any) => { layers.push(factory()) } },
    storage: {
      store: () => [stored, async (mutation: (draft: { includeAgent: boolean }) => void) => {
        mutation(stored)
        updates.push({ ...stored })
      }],
    },
    data: { session: { pending: { list: () => [] } } },
    ui: {
      dialog: { set() {}, clear() {} },
      router: { current: () => ({ type: "session", sessionID: "s1" }) },
      toast: { show() {} },
    },
  } as unknown as Context
  const lifetime = new AbortController()
  const render = () => <SessionSearchDialog context={context} controller={controller} navigator={navigator} sessionID="s1" revision={revision} lifetime={lifetime} noticeDuration={options.noticeDuration} onFailure={options.onFailure} />
  return { clipboard, jumps, updates, stored: () => stored, layers, index, render }
}

type Harness = ReturnType<typeof createHarness>

async function render(harness: Harness) {
  return testRender(() => <box width="100%" height="100%">{harness.render()}</box>, { width: 88, height: 40 })
}

function command(harness: Harness, title: string) {
  const layer = [...harness.layers].reverse().find((entry) => entry.commands.some((item) => item.title === title))
  const selected = layer?.commands.find((item) => item.title === title)
  if (!selected) throw new Error(`Missing command: ${title}`)
  selected.run()
}

function findInput(root: Renderable): InputRenderable | undefined {
  if (root instanceof InputRenderable) return root
  for (const child of root.getChildren()) {
    const found = findInput(child)
    if (found) return found
  }
  return undefined
}

async function waitFor(app: Awaited<ReturnType<typeof render>>, check: (frame: string) => boolean, message: string) {
  const deadline = Date.now() + 2_000
  while (Date.now() < deadline) {
    await app.flush()
    const frame = app.captureCharFrame()
    if (check(frame)) return frame
    await Bun.sleep(5)
  }
  throw new Error(`${message}\n${app.captureCharFrame()}`)
}

test("defaults to user messages, toggles agent text, and copies without jumping", async () => {
  const harness = createHarness()
  const app = await render(harness)
  try {
    await waitFor(app, (frame) => frame.includes("user message one"), "session search results did not render")
    expect(app.captureCharFrame()).toContain("user only")
    expect(app.captureCharFrame()).toMatch(/─{40,}/)
    expect(app.captureCharFrame()).not.toContain("agent message one")
    expect(harness.layers.flatMap((layer) => layer.commands).find((item) => item.title === "Copy selected message")?.bind).toBe("ctrl+y")
    expect(harness.layers.flatMap((layer) => layer.commands).find((item) => item.title === "Toggle agent messages")?.bind).toBe("ctrl+t")

    command(harness, "Copy selected message")
    expect(harness.clipboard).toEqual(["user message one"])
    expect(harness.jumps).toEqual([])
    await waitFor(app, (frame) => frame.includes("Copied user message"), "copy confirmation did not appear")
    expect(app.captureCharFrame()).toContain("Search current session")

    command(harness, "Toggle agent messages")
    await waitFor(app, (frame) => frame.includes("agent message one") && frame.includes("user + agent"), "agent messages did not appear")
    expect(app.captureCharFrame()).not.toContain("Copied user message")
    expect(app.captureCharFrame()).toContain("ctrl+t user only")
    command(harness, "Next result")
    command(harness, "Copy selected message")
    expect(harness.clipboard.at(-1)).toBe("agent message one")
    await waitFor(app, (frame) => frame.includes("Copied agent message"), "agent copy confirmation did not appear")

    command(harness, "Toggle agent messages")
    await waitFor(app, (frame) => frame.includes("user only") && !frame.includes("agent message one"), "agent messages did not hide")
    expect(app.captureCharFrame()).toContain("ctrl+t show agent")
    expect(harness.jumps).toEqual([])
  } finally { app.renderer.destroy() }
})

test("uses defaultIncludeAgent, shows result metadata, remembers role changes, and opens help", async () => {
  const harness = createHarness({ defaultIncludeAgent: true })
  const app = await render(harness)
  try {
    await waitFor(app, (frame) => frame.includes("agent message one"), "agent messages did not render by default")
    const frame = app.captureCharFrame()
    expect(frame).toContain("user + agent")
    expect(frame).toContain("User · message start ·")
    expect(frame).toContain("1m ago")
    expect(frame).toContain("Agent (build) · part")

    const commands = harness.layers.flatMap((layer) => layer.commands)
    expect(commands.find((item) => item.title === "Toggle agent messages")?.bind).toBe("ctrl+t")
    expect(commands.some((item) => item.title === "Toggle session search help" && item.bind === "f1")).toBe(true)
    expect(commands.some((item) => item.title === "Toggle session search help" && item.bind === "?")).toBe(true)

    command(harness, "Toggle agent messages")
    await waitFor(app, (frame) => frame.includes("user only"), "agent messages did not hide")
    await waitFor(app, () => harness.updates.length === 1, "role preference was not stored")
    expect(harness.stored().includeAgent).toBe(false)
    expect(harness.updates.at(-1)).toEqual({ includeAgent: false })

    command(harness, "Toggle session search help")
    await waitFor(app, (frame) => frame.includes("close help"), "help panel did not open")
    command(harness, "Toggle session search help")
    await waitFor(app, (frame) => !frame.includes("close help"), "help panel did not close")
  } finally {
    app.renderer.destroy()
  }
})

test("restores a stored role preference over the configured default", async () => {
  const harness = createHarness({ storedIncludeAgent: true })
  const app = await render(harness)
  try {
    await waitFor(app, (frame) => frame.includes("agent message one"), "stored agent role was not restored")
    expect(app.captureCharFrame()).toContain("user + agent")
    expect(harness.updates).toEqual([])
  } finally {
    app.renderer.destroy()
  }
})

test("copies the full selected text instead of the truncated preview", async () => {
  const text = "Long message " + "content ".repeat(40) + "TAIL_MARKER"
  const harness = createHarness({ userText: text })
  const app = await render(harness)
  try {
    await waitFor(app, (frame) => frame.includes("2/2 matches"), "long copy fixture did not render")
    expect(app.captureCharFrame()).toContain("…")
    command(harness, "Copy selected message")
    expect(harness.clipboard).toEqual([text])
    expect(harness.clipboard[0]).toContain("TAIL_MARKER")
    await waitFor(app, (frame) => frame.includes("Copied user message"), "long copy notice did not appear")
  } finally { app.renderer.destroy() }
})

test("copies every text part of the selected assistant message and keeps the panel usable", async () => {
  const harness = createHarness()
  harness.index.upsert({
    id: "a2",
    type: "assistant",
    time: { created: Date.now() - 30_000 },
    agent: "build",
    content: [
      { type: "text", text: "first agent part" },
      { type: "text", text: "second agent part" },
    ],
  })
  const app = await render(harness)
  try {
    await waitFor(app, (frame) => frame.includes("user message one"), "session search results did not render")
    command(harness, "Toggle agent messages")
    await waitFor(app, (frame) => frame.includes("first agent part"), "combined agent message did not render")
    command(harness, "Previous result")
    command(harness, "Copy selected message")
    expect(harness.clipboard.at(-1)).toBe("first agent part\n\nsecond agent part")
    expect(harness.jumps).toEqual([])
    command(harness, "Jump to message")
    expect(harness.jumps).toEqual(["second agent part"])
  } finally {
    app.renderer.destroy()
  }
})

test("keeps the panel open when a jump cannot render the exact part", async () => {
  const failures: string[] = []
  const harness = createHarness({ jumpFails: true, onFailure: (message) => failures.push(message) })
  const app = await render(harness)
  try {
    await waitFor(app, (frame) => frame.includes("user message one"), "session search results did not render")
    command(harness, "Jump to message")
    await waitFor(app, () => failures.length === 1, "jump failure was not reported")
    expect(failures[0]).toContain("exact part did not render")
    expect(app.captureCharFrame()).toContain("Search current session")
    expect(harness.jumps).toEqual([])
  } finally {
    app.renderer.destroy()
  }
})

test("reports copy failures, resets the notice, and copies only a selected result", async () => {
  const failed = createHarness({ copy: false })
  const failedApp = await render(failed)
  try {
    await waitFor(failedApp, (frame) => frame.includes("user message one"), "failed copy fixture did not render")
    command(failed, "Copy selected message")
    expect(failed.clipboard).toEqual([])
    await waitFor(failedApp, (frame) => frame.includes("Could not copy to clipboard"), "copy failure was not reported")
  } finally { failedApp.renderer.destroy() }

  const harness = createHarness({ noticeDuration: 1000 })
  const app = await render(harness)
  try {
    await waitFor(app, (frame) => frame.includes("user message one"), "notice fixture did not render")
    command(harness, "Copy selected message")
    await waitFor(app, (frame) => frame.includes("Copied user message"), "copy notice did not appear")
    await Bun.sleep(600)
    command(harness, "Copy selected message")
    await Bun.sleep(600)
    await app.flush()
    expect(app.captureCharFrame()).toContain("Copied user message")
    await waitFor(app, (frame) => !frame.includes("Copied user message"), "copy notice did not reset")

    command(harness, "Copy selected message")
    await waitFor(app, (frame) => frame.includes("Copied user message"), "copy notice did not reappear")
    findInput(app.renderer.root)!.value = "second"
    await waitFor(app, (frame) => !frame.includes("Copied user message"), "query change did not clear the copy notice")

    findInput(app.renderer.root)!.value = "missing"
    await waitFor(app, (frame) => frame.includes("No matching dialogue"), "empty result state did not render")
    command(harness, "Copy selected message")
    await waitFor(app, (frame) => frame.includes("Select a message to copy"), "missing selection was not reported")
    expect(harness.clipboard).toEqual(["user message one", "user message one", "user message one"])
  } finally { app.renderer.destroy() }
})
