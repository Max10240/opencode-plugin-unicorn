/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import type { Context } from "@opencode/plugin/tui/context"
import { testRender } from "@opentui/solid"
import { createSignal } from "solid-js"
import type { JSX } from "solid-js"
import { setupRecommendedConfigTui } from "../../src/tui.js"

const theme = {
  text: { base: "#ffffff", muted: "#aaaaaa", formfield: { base: "#ffffff" }, feedback: { error: { base: "#ff0000" } } },
  background: { raised: { high: "#333333" } },
  surface: () => theme,
}

test("opens a read-only recommended config status panel", async () => {
  const layers: Array<{ commands: Array<{ id?: string; title?: string; run: () => void }> }> = []
  const [dialog, setDialog] = createSignal<{ render: () => JSX.Element } | undefined>()
  const context = {
    options: {},
    theme,
    keymap: { layer: (factory: () => any) => layers.push(factory()) },
    client: {
      rpc: () => ({
        status: async () => ({
          directory: "/home/user/.config/opencode",
          configFiles: ["/home/user/.config/opencode/opencode.jsonc"],
          enabled: true,
          rules: { total: 4, present: 3, missing: ["Missing rule"] },
          commands: { total: 5, present: ["one", "two"], missing: ["three"] },
        }),
      }),
    },
    ui: {
      dialog: {
        show(render: () => JSX.Element) { setDialog({ render }) },
        set() {},
        clear() { setDialog(undefined) },
      },
    },
  } as unknown as Context

  setupRecommendedConfigTui(context)
  const open = layers.flatMap((layer) => layer.commands)[0]!
  open.run()
  const app = await testRender(() => <box width="100%" height="100%">{(() => { const entry = dialog(); return entry ? entry.render() : null })()}</box>, { width: 120, height: 30 })
  try {
    const deadline = Date.now() + 2_000
    let frame = ""
    while (Date.now() < deadline) {
      await app.flush()
      frame = app.captureCharFrame()
      if (frame.includes("3/4 present")) break
      await Bun.sleep(5)
    }
    expect(frame).toContain("Recommended config")
    expect(frame).toContain("Read-only status")
    expect(frame).toContain("Automatic updates: enabled")
    expect(frame).toContain("Rules: 3/4 present")
    expect(frame).toContain("Missing rules: Missing rule")
    expect(frame).toContain("Commands: 2/5 present")
    expect(frame).toContain("Missing commands: three")
    const toggleHelp = layers.flatMap((layer) => layer.commands).find((command) => command.title === "Toggle recommended help")!
    toggleHelp.run()
    await app.flush()
    expect(app.captureCharFrame()).toContain("Rules and commands are applied automatically")
    toggleHelp.run()
    await app.flush()
    expect(app.captureCharFrame()).not.toContain("Rules and commands are applied automatically")
  } finally {
    app.renderer.destroy()
  }
})
