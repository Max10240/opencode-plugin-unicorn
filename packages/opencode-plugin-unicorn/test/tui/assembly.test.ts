import { expect, test } from "bun:test"
import type { Context } from "@opencode/plugin/tui/context"
import { createComputed, createRoot, createSignal } from "solid-js"
import unicorn from "../../src/tui.js"
import { childContext } from "../../src/options.js"

test("TUI assembly honors both the Unicorn feature gate and show-img's own nested options", async () => {
  for (const feature of [false, true]) {
    for (const nested of [false, true]) {
      let slots = 0
      const context = {
        options: {
          features: { promptSearch: false, sessionSearch: false, showImg: feature },
          showImg: { features: { showImg: nested } },
        },
        ui: { slot: () => { slots++; return () => { slots-- } } },
        keymap: { layer: () => {} },
      } as unknown as Context
      const cleanup = await unicorn.setup(context)
      expect(slots).toBe(Number(feature && nested))
      if (cleanup) await cleanup()
      expect(slots).toBe(0)
    }
  }
})

test("scoped TUI contexts retain reactive host getters", () => {
  createRoot((dispose) => {
    const [theme, setTheme] = createSignal("dark")
    const context = Object.freeze({ options: { promptSearch: { keybind: "f12" }, sessionSearch: { keybind: "f11" } }, get theme() { return theme() } })
    const prompts = childContext(context, "promptSearch")
    const sessions = childContext(context, "sessionSearch")
    const seen: string[] = []
    createComputed(() => { seen.push(`${prompts.theme}/${sessions.theme}`) })
    setTheme("light")
    expect(seen).toEqual(["dark/dark", "light/light"])
    expect(prompts.options).toBe(context.options.promptSearch)
    expect(sessions.options).toBe(context.options.sessionSearch)
    dispose()
  })
})
