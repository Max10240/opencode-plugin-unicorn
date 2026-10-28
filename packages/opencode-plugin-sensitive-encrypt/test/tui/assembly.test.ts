import { expect, test } from "bun:test"
import { setupSensitiveEncryptTui } from "../../src/tui.js"

function setup(options: Record<string, unknown>) {
  let layer: any
  const context = {
    options,
    keymap: {
      layer: (factory: () => any) => { layer = factory() },
    },
  } as any
  setupSensitiveEncryptTui(context)
  return layer
}

test("registers a persistent one-shot encryption command", () => {
  const layer = setup({})
  const commands = layer.commands
  expect(layer.mode).toBe("global")
  expect(commands).toHaveLength(1)
  expect(commands[0]).toMatchObject({
    id: "sensitive-encrypt.encrypt",
    bind: false,
    palette: true,
    slash: { name: "encrypt-sensitive" },
  })
})

test("does not register when encryption is disabled", () => {
  expect(setup({ encrypt: false })).toBeUndefined()
  expect(setup({ enabled: false })).toBeUndefined()
})
