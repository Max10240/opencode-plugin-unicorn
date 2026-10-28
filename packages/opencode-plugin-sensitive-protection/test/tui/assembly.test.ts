import { expect, test } from "bun:test"
import { setupSensitiveProtectionTui } from "../../src/tui.js"

function setup(options: Record<string, unknown>) {
  let commands: any[] = []
  const context = {
    options,
    keymap: { layer: (factory: () => any) => { commands = factory().commands ?? [] } },
  } as any
  setupSensitiveProtectionTui(context)
  return commands
}

test("registers a keymap command for protecting a file", () => {
  const commands = setup({})
  expect(commands).toHaveLength(1)
  expect(commands[0]).toMatchObject({
    id: "sensitive-protection.register",
    bind: false,
    palette: true,
    slash: { name: "protect-sensitive-file-ui" },
  })
})

test("does not register when protection is disabled", () => {
  expect(setup({ enabled: false })).toHaveLength(0)
})
