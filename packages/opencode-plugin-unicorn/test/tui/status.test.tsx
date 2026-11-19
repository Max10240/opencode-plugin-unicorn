/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import type { Context } from "@opencode/plugin/tui/context"
import { testRender } from "@opentui/solid"
import { createSignal } from "solid-js"
import type { JSX } from "solid-js"
import { unicornStatusCommand } from "../../src/status-dialog.js"

const theme = {
  text: { base: "#ffffff", muted: "#aaaaaa", formfield: { base: "#ffffff" }, feedback: { warning: { base: "#ffaa00" }, error: { base: "#ff0000" } } },
  background: { raised: { high: "#333333" } },
  surface: () => theme,
}

test("shows features, keybinds, defaults, versions, and shadow status", async () => {
  const layers: Array<{ commands: Array<{ id?: string; title?: string; run: () => void }> }> = []
  const [dialog, setDialog] = createSignal<{ render: () => JSX.Element } | undefined>()
  const context = {
    options: {
      features: { nonBlocking: false },
      promptSearch: { defaultScope: "project" },
      sessionSearch: { defaultIncludeAgent: true },
      notepad: { defaultSort: "created" },
    },
    app: { version: "2.2.7", channel: "latest" },
    theme,
    keymap: {
      layer: (factory: () => any) => layers.push(factory()),
      shortcuts: (id: string) => id === "max10240.prompt-search.open" ? ["ctrl+shift+r"] : [],
      commands: () => [
        { id: "max10240.prompt-search.open", bind: "ctrl+shift+r" },
        { id: "max10240.session-search.open", bind: "ctrl+shift+r" },
      ],
    },
    client: { rpc: () => ({ runtime: async () => ({ version: "1.0.32", packagePath: "/repo/.local/unicorn-shadow/node_modules/@max10240/opencode-plugin-unicorn", shadow: true, commit: "dfc781c", dirty: true }) }) },
    ui: {
      dialog: {
        show(render: () => JSX.Element) { setDialog({ render }) },
        set() {},
        clear() { setDialog(undefined) },
      },
    },
  } as unknown as Context

  unicornStatusCommand(context)
  const open = layers.flatMap((layer) => layer.commands).find((command) => command.id === "max10240.unicorn.status.open")!
  open.run()
  const app = await testRender(() => <box width="100%" height="100%">{(() => { const entry = dialog(); return entry ? entry.render() : null })()}</box>, { width: 120, height: 60 })
  try {
    const deadline = Date.now() + 2_000
    let frame = ""
    while (Date.now() < deadline) {
      await app.flush()
      frame = app.captureCharFrame()
      if (frame.includes("Plugin 1.0.32")) break
      await Bun.sleep(5)
    }
    expect(frame).toContain("Unicorn status")
    expect(frame).toContain("Plugin 1.0.32 · shadow snapshot")
    expect(frame).toContain("dirty worktree")
    expect(frame).toContain("Non-blocking (off)")
    expect(frame).toContain("features.nonBlocking=false")
    expect(frame).toContain("Prompt search scope: current project")
    expect(frame).toContain("Session search role: user + agent")
    expect(frame).toContain("Notepad sort: created")
    expect(frame).toContain("ctrl+shift+r")
    expect(frame).toContain("Protection history: Ctrl+Shift+H")
    expect(frame).toContain("Potential conflicts")
    const toggleHelp = layers.flatMap((layer) => layer.commands).find((command) => command.title === "Toggle unicorn help")!
    toggleHelp.run()
    await app.flush()
    expect(app.captureCharFrame()).toContain("Features show the current switch state")
    toggleHelp.run()
    await app.flush()
    expect(app.captureCharFrame()).not.toContain("Features show the current switch state")
  } finally {
    app.renderer.destroy()
  }
})
