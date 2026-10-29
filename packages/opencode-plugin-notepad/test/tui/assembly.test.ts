import { expect, test } from "bun:test"
import { COMMAND_ID, DEFAULT_KEYBIND, setupNotepadTui } from "../../src/tui.js"

function setup(options: Record<string, unknown>) {
  let layer: any
  const context = {
    options,
    keymap: { layer: (factory: () => any) => { layer = factory() } },
  } as any
  setupNotepadTui(context)
  return layer
}

test("registers a globally reachable notepad command", () => {
  const layer = setup({})
  expect(layer.mode).toBe("global")
  expect(layer.commands).toHaveLength(1)
  expect(layer.commands[0]).toMatchObject({
    id: COMMAND_ID,
    bind: DEFAULT_KEYBIND,
    palette: true,
    slash: { name: "notepad" },
  })
})

test("supports a custom keybind and disabling the shortcut", () => {
  expect(setup({ keybind: "alt+n" }).commands[0].bind).toBe("alt+n")
  expect(setup({ keybind: false }).commands[0].bind).toBe(false)
})

test("does not register when disabled", () => {
  expect(setup({ enabled: false })).toBeUndefined()
})
