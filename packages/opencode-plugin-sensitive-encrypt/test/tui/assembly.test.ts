import { expect, test } from "bun:test"
import { setupSensitiveEncryptTui } from "../../src/tui.js"

function setup(options: Record<string, unknown>) {
  let commands: any[] = []
  const context = {
    options,
    keymap: {
      layer: (factory: () => any) => { commands = factory().commands ?? [] },
    },
  } as any
  setupSensitiveEncryptTui(context)
  return commands
}

test("registers a persistent one-shot encryption command", () => {
  const commands = setup({})
  expect(commands).toHaveLength(1)
  expect(commands[0]).toMatchObject({
    id: "sensitive-encrypt.encrypt",
    bind: false,
    palette: true,
    slash: { name: "encrypt-sensitive" },
  })
})

test("does not register when encryption is disabled", () => {
  expect(setup({ encrypt: false })).toHaveLength(0)
  expect(setup({ enabled: false })).toHaveLength(0)
})
