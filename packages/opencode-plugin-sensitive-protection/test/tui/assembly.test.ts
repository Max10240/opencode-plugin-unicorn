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

test("shows a top-right toast for protection hits", () => {
  let layer: any
  let handler: ((event: any) => void) | undefined
  const toasts: any[] = []
  const cleanups: Array<() => void> = []
  const context = {
    options: {},
    keymap: { layer: (factory: () => any) => { layer = factory() } },
    client: {
      rpc: () => ({
        events: {
          on: (name: string, callback: (event: any) => void) => {
            expect(name).toBe("hit")
            handler = callback
            return () => cleanups.push(() => {})
          },
        },
      }),
    },
    ui: {
      toast: {
        show: (value: any) => toasts.push(value),
      },
    },
  } as any
  const cleanup = setupSensitiveProtectionTui(context)
  expect(layer.commands).toHaveLength(1)
  handler!({ data: { kind: "blocked", source: "read", count: 1, file: "/home/max/.ssh/id_ed25519", tool: "read" } })
  handler!({ data: { kind: "redacted", source: "tool", count: 2, tool: "shell" } })
  expect(toasts).toHaveLength(2)
  expect(toasts[0]).toMatchObject({ variant: "warning" })
  expect(toasts[0].message).toContain("Blocked read")
  expect(toasts[1]).toMatchObject({ variant: "info" })
  expect(toasts[1].message).toContain("2 sensitive values")
  cleanup?.()
})
