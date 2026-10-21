import { expect, test } from "bun:test"
import { createComputed, createRoot, createSignal } from "solid-js"
import type { Context } from "@opencode/plugin/tui/context"
import { COMMAND_ID, DEFAULT_KEYBIND, setupSessionSearch } from "../../src/tui.js"
import { registerKeymap } from "../../src/keymap.js"

function fixture(options: Record<string, unknown> = {}) {
  let calls = 0
  let listeners = 0
  let slots = 0
  let closed = 0
  let stopped = 0
  let toasts = 0
  let onClose: (() => void) | undefined
  let route: any = { type: "home" }
  const commands: any[] = []
  const context = {
    options,
    client: { session: { get: async () => { calls++; return {} } }, message: { list: async () => { calls++; return { data: [], cursor: {} } } } },
    data: { listen: () => { listeners++; return () => { stopped++ } }, session: {} },
    renderer: {},
    keymap: { layer: (factory: () => any) => commands.push(...factory().commands), commands: () => commands },
    ui: {
      router: { current: () => route },
      toast: { show: () => { toasts++ } },
      dialog: {
        clear() { const close = onClose; onClose = undefined; close?.() },
        show(_render: () => unknown, close?: () => void) { context.ui.dialog.clear(); onClose = close },
      },
      slot: (claim: any) => {
        slots++
        const dispose = createRoot((dispose) => { claim.render(); return dispose })
        return () => { closed++; dispose() }
      },
    },
  } as unknown as Context
  return { context, commands, route: (value: any) => { route = value }, dialogOpen: () => onClose !== undefined, stats: () => ({ calls, listeners, slots, closed, stopped, toasts }) }
}

test("disabled standalone search registers nothing and performs no background indexing", () => {
  const current = fixture({ features: { sessionSearch: false } })
  const stop = setupSessionSearch(current.context)
  stop()
  expect(current.stats()).toEqual({ calls: 0, listeners: 0, slots: 0, closed: 0, stopped: 0, toasts: 0 })
})

test("enabled search is lazy, guards non-session routes and cleans up its own registrations", () => {
  const current = fixture()
  const stop = setupSessionSearch(current.context)
  const open = current.commands.find((command) => command.id === COMMAND_ID)
  expect(open.bind).toBe(DEFAULT_KEYBIND)
  expect(current.stats().calls).toBe(0)
  open.run()
  expect(current.stats().toasts).toBe(1)
  expect(current.stats().calls).toBe(0)
  stop()
  expect(current.stats().closed).toBe(1)
  expect(current.stats().stopped).toBe(1)
})

test("eager host validation cannot subscribe the slot owner to keymap state", () => {
  createRoot((dispose) => {
    const [busy, setBusy] = createSignal(false)
    let owners = 0
    let updates = 0
    let enabled = false
    const context = { keymap: { layer(factory: () => any) {
      factory().enabled()
      createComputed(() => { enabled = factory().enabled(); updates++ })
    } } } as unknown as Pick<Context, "keymap">
    createComputed(() => {
      owners++
      registerKeymap(context, () => ({ enabled: busy, commands: [] }))
    })
    setBusy(true)
    expect(owners).toBe(1)
    expect(updates).toBe(2)
    expect(enabled).toBe(true)
    dispose()
  })
})

test("unloading closes its own search but never closes a replacement dialog", () => {
  for (const replacement of [false, true]) {
    const current = fixture()
    current.route({ type: "session", sessionID: "current" })
    const stop = setupSessionSearch(current.context)
    current.commands.find((command) => command.id === COMMAND_ID).run()
    expect(current.dialogOpen()).toBe(true)
    let externalClosed = false
    if (replacement) current.context.ui.dialog.show(() => null, () => { externalClosed = true })
    stop()
    expect(current.dialogOpen()).toBe(replacement)
    expect(externalClosed).toBe(false)
  }
})
