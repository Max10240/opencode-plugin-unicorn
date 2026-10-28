import { expect, test } from "bun:test"
import { setupSensitiveProtectionTui } from "../../src/tui.js"

function setup(options: Record<string, unknown>) {
  let layer: any
  const context = {
    options,
    keymap: { layer: (factory: () => any) => { layer = factory() } },
  } as any
  setupSensitiveProtectionTui(context)
  return layer
}

test("registers a keymap command for protecting a file", () => {
  const layer = setup({})
  const commands = layer.commands
  expect(layer.mode).toBe("global")
  expect(commands).toHaveLength(1)
  expect(commands[0]).toMatchObject({
    id: "sensitive-protection.register",
    bind: false,
    palette: true,
    slash: { name: "protect-sensitive-file-ui" },
  })
})

test("does not register when protection is disabled", () => {
  expect(setup({ enabled: false })).toBeUndefined()
})
