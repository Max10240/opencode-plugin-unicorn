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

function setupWithRpc(options: Record<string, unknown> = {}) {
  let layer: any
  let handler: ((event: any) => void) | undefined
  let pendingHandler: ((event: any) => void) | undefined
  const toasts: any[] = []
  const slots: any[] = []
  const context = {
    options,
    keymap: {
      layer: (factory: () => any) => { layer = factory() },
      shortcuts: (id: string) => id === "sensitive-protection.history" ? ["ctrl+shift+h"] : [],
    },
    client: {
      rpc: () => ({
        events: {
          on: (name: string, callback: (event: any) => void) => {
            if (name === "hit") handler = callback
            if (name === "pending") pendingHandler = callback
            return () => {}
          },
        },
        history: async () => ({ hits: [], total: 0, limit: 200 }),
        clear: async () => ({ cleared: 0 }),
        pending: async () => ({ requests: [], count: 0 }),
        resolve: async () => ({ resolved: true }),
      }),
    },
    ui: {
      toast: { show: (value: any) => toasts.push(value) },
      slot: (claim: any) => { slots.push(claim); return () => {} },
    },
  } as any
  const cleanup = setupSensitiveProtectionTui(context)
  return { context, layer, toasts, slots, cleanup, emit: (data: any) => handler!({ data }), emitPending: (data: any) => pendingHandler!({ data }) }
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

test("registers history, a footer chip, and a configurable keybind", () => {
  const harness = setupWithRpc({ notifications: true })
  expect(harness.layer.commands).toHaveLength(3)
  expect(harness.layer.commands[1]).toMatchObject({
    id: "sensitive-protection.history",
    title: "Sensitive protection history",
    bind: "ctrl+shift+h",
    palette: true,
    slash: { name: "protection-history" },
  })
  expect(harness.slots).toHaveLength(1)
  expect(harness.slots[0].append).toBe("prompt.footer.status")
  harness.cleanup?.()

  const custom = setupWithRpc({ historyKeybind: "ctrl+shift+y" })
  expect(custom.layer.commands[1].bind).toBe("ctrl+shift+y")
  custom.cleanup?.()

  const unbound = setupWithRpc({ historyKeybind: false })
  expect(unbound.layer.commands[1].bind).toBe(false)
  unbound.cleanup?.()
})

test("deduplicates repeated protection hits and reports the shortcut", () => {
  const harness = setupWithRpc({ notifications: true })
  const hit = {
    id: "hit-1",
    time: Date.now(),
    firstTime: Date.now(),
    occurrences: 1,
    kind: "blocked",
    source: "read",
    count: 1,
    file: "/home/max/.ssh/id_ed25519",
    tool: "read",
  }
  harness.emit(hit)
  harness.emit({ ...hit, occurrences: 2, time: Date.now() })
  expect(harness.toasts).toHaveLength(1)
  expect(harness.toasts[0]).toMatchObject({ variant: "warning" })
  expect(harness.toasts[0].message).toContain("Blocked read")
  expect(harness.toasts[0].message).toContain("ctrl+shift+h details")

  harness.emit({ ...hit, id: "hit-2", kind: "redacted", source: "tool", count: 2, tool: "shell" })
  expect(harness.toasts).toHaveLength(2)
  expect(harness.toasts[1]).toMatchObject({ variant: "info" })
  expect(harness.toasts[1].message).toContain("2 sensitive values")
  harness.cleanup?.()
})

test("does not emit toasts when notifications are disabled", () => {
  const harness = setupWithRpc({ notifications: false })
  expect(harness.layer.commands).toHaveLength(3)
  expect(harness.slots).toHaveLength(1)
  harness.emit({ kind: "blocked", source: "read", count: 1, file: "/secret" })
  expect(harness.toasts).toHaveLength(0)
  harness.cleanup?.()
})
