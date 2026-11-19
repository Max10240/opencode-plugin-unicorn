/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { InputRenderable, type Renderable, TextareaRenderable } from "@opentui/core"
import { testRender } from "@opentui/solid"
import type { Context } from "@opencode/plugin/tui/context"
import { createSignal } from "solid-js"
import type { JSX } from "solid-js"
import { setupSensitiveEncryptTui } from "../../src/tui.js"

const KEYS = [
  { role: "decrypt" as const, keyID: "decrypt-key-identifier" },
  { role: "encrypt" as const, keyID: "encrypt-key-identifier" },
]

type Harness = Awaited<ReturnType<typeof createHarness>>

const theme = {
  text: { base: "#ffffff", muted: "#aaaaaa", formfield: { base: "#ffffff" }, feedback: { error: { base: "#ff0000" } } },
  background: { raised: { high: "#333333" } },
  formfield: { base: "#ffffff" },
  surface: () => theme,
}

function createHarness(options: { enabled?: boolean; keys?: typeof KEYS } = {}) {
  const calls: Array<{ kind: string; input: Record<string, unknown> }> = []
  const clipboard: string[] = []
  const toasts: string[] = []
  const layers: Array<{ mode: string; target?: () => Renderable | undefined; commands: Array<{ bind?: string; title?: string; run: () => void }> }> = []
  const [dialog, setDialog] = createSignal<{ render: () => JSX.Element } | undefined>()
  const setDialogRender = (render: (() => JSX.Element) | undefined) => setDialog(render ? { render } : undefined)
  const context = {
    options: options.enabled === false ? { enabled: false } : {},
    location: { directory: "/workspace" },
    client: {
      rpc: () => ({
        keys: async () => {
          calls.push({ kind: "keys", input: {} })
          return { keys: options.keys ?? KEYS, defaultRole: "decrypt" }
        },
        encryptText: async (input: Record<string, unknown>) => {
          calls.push({ kind: "text", input })
          return { ciphertext: `ocsec1:${String(input.text)}`, out: input.out, keyID: "decrypt-key-identifier", bytes: 128 }
        },
        encrypt: async (input: Record<string, unknown>) => {
          calls.push({ kind: "file", input })
          return { ciphertext: "ocsec1:file", out: input.out, keyID: "decrypt-key-identifier", bytes: 256 }
        },
      }),
    },
    theme,
    renderer: { copyToClipboardOSC52: (text: string) => { clipboard.push(text); return true } },
    keymap: { layer: (factory: () => any) => { layers.push(factory()) } },
    ui: {
      dialog: {
        set() {},
        show(render: () => JSX.Element) { setDialogRender(render) },
        clear() { setDialogRender(undefined) },
      },
      toast: { show: (input: { message: string }) => { toasts.push(input.message) } },
    },
  } as unknown as Context

  setupSensitiveEncryptTui(context)
  return { context, calls, clipboard, toasts, layers, dialog, setDialogRender }
}

async function render(harness: Harness) {
  return testRender(() => (
    <box width="100%" height="100%">
      {(() => { const entry = harness.dialog(); return entry ? entry.render() : null })()}
    </box>
  ), { width: 100, height: 40 })
}

function findAll<T extends Renderable>(root: Renderable, type: new (...args: any[]) => T, found: T[] = []): T[] {
  if (root instanceof type) found.push(root)
  for (const child of root.getChildren()) findAll(child, type, found)
  return found
}

async function waitFor(app: Awaited<ReturnType<typeof render>>, check: () => boolean, message: string) {
  const deadline = Date.now() + 2_000
  while (Date.now() < deadline) {
    await app.flush()
    if (check()) return
    await Bun.sleep(5)
  }
  throw new Error(`${message}\n${app.captureCharFrame()}`)
}

function command(harness: Harness, title: string) {
  const layer = [...harness.layers].reverse().find((entry) => entry.commands.some((command) => command.title === title))
  const selected = layer?.commands.find((command) => command.title === title)
  if (!selected) throw new Error(`Missing command: ${title}`)
  selected.run()
}

function commandByBind(harness: Harness, title: string, bind: string) {
  const selected = harness.layers.flatMap((layer) => layer.commands).find((command) => command.title === title && command.bind === bind)
  if (!selected) throw new Error(`Missing command: ${title} (${bind})`)
  selected.run()
}

test("encrypts text, shows the result dialog, copies both values and closes", async () => {
  const harness = createHarness()
  const app = await render(harness)
  try {
    command(harness, "Encrypt sensitive data")
    await waitFor(app, () => app.captureCharFrame().includes("Type any text to encrypt"), "encryption panel did not open")
    await Bun.sleep(60)
    findAll(app.renderer.root, TextareaRenderable)[0].setText("secret text")
    const output = findAll(app.renderer.root, InputRenderable)[0]
    output.value = "/tmp/out.ocsec"
    command(harness, "Encrypt")
    await waitFor(app, () => app.captureCharFrame().includes("Encrypted with key"), "result dialog did not open")
    expect(harness.calls.at(-1)).toEqual({ kind: "text", input: { text: "secret text", key: "decrypt", out: "/tmp/out.ocsec" } })
    expect(app.captureCharFrame()).toContain("Output: /tmp/out.ocsec")
    expect(harness.layers.flatMap((layer) => layer.commands).some((command) => command.title === "Copy ciphertext" && command.bind === "ctrl+y")).toBe(true)
    command(harness, "Copy output path")
    expect(harness.clipboard.at(-1)).toBe("/tmp/out.ocsec")
    command(harness, "Copy ciphertext")
    expect(harness.clipboard.at(-1)).toBe("ocsec1:secret text")
    command(harness, "Close encryption panel")
    await waitFor(app, () => !app.captureCharFrame().includes("Encrypted with key"), "result dialog did not close")
  } finally {
    app.renderer.destroy()
  }
})

test("masks text by default, reveals it with ctrl+r, encrypts with enter, and copies with enter", async () => {
  const harness = createHarness()
  const app = await render(harness)
  try {
    command(harness, "Encrypt sensitive data")
    await waitFor(app, () => app.captureCharFrame().includes("Type any text to encrypt"), "encryption panel did not open")
    const textarea = findAll(app.renderer.root, TextareaRenderable)[0]
    const masked = textarea.textColor.toString()
    command(harness, "Reveal or hide text")
    expect(textarea.textColor.toString()).not.toBe(masked)
    command(harness, "Reveal or hide text")
    expect(textarea.textColor.toString()).toBe(masked)

    command(harness, "Toggle encrypt help")
    await waitFor(app, () => app.captureCharFrame().includes("F1 closes help"), "encrypt help did not open")
    command(harness, "Toggle encrypt help")
    await waitFor(app, () => !app.captureCharFrame().includes("F1 closes help"), "encrypt help did not close")

    textarea.setText("secret text")
    await waitFor(app, () => {
      const frame = app.captureCharFrame()
      return frame.includes("*") && frame.includes("Masked")
    }, "masked placeholder did not replace the plaintext")

    commandByBind(harness, "Encrypt", "return")
    await waitFor(app, () => app.captureCharFrame().includes("Encrypted with key"), "enter did not encrypt")
    expect(app.captureCharFrame()).toContain("Plaintext input cleared.")
    expect(harness.calls.at(-1)).toEqual({ kind: "text", input: { text: "secret text", key: "decrypt" } })

    commandByBind(harness, "Copy ciphertext", "c")
    expect(harness.clipboard.at(-1)).toBe("ocsec1:secret text")
    expect(app.captureCharFrame()).toContain("Encrypted with key")

    commandByBind(harness, "Copy ciphertext and close", "return")
    expect(harness.clipboard.at(-1)).toBe("ocsec1:secret text")
    await waitFor(app, () => harness.dialog() === undefined, "enter did not close the result dialog")
  } finally {
    app.renderer.destroy()
  }
})

test("switches text and file modes and changes the encryption key", async () => {
  const harness = createHarness()
  const app = await render(harness)
  try {
    command(harness, "Encrypt sensitive data")
    await waitFor(app, () => app.captureCharFrame().includes("Type any text to encrypt"), "encryption panel did not open")
    command(harness, "Switch text or file")
    await waitFor(app, () => app.captureCharFrame().includes("[File]"), "file mode did not activate")
    command(harness, "Switch text or file")
    await waitFor(app, () => app.captureCharFrame().includes("[Text]"), "text mode did not reactivate")
    command(harness, "Switch text or file")
    await waitFor(app, () => app.captureCharFrame().includes("[File]"), "file mode did not reactivate")
    const inputs = findAll(app.renderer.root, InputRenderable)
    inputs[0].value = "/tmp/secret.txt"
    inputs[1].value = "/tmp/secret.ocsec"
    command(harness, "Focus encryption key")
    command(harness, "Next encryption key")
    await waitFor(app, () => app.captureCharFrame().includes("Key: Encrypt"), "encryption key did not change")
    command(harness, "Encrypt")
    await waitFor(app, () => app.captureCharFrame().includes("Encrypted with key"), "file encryption result did not open")
    expect(harness.calls.at(-1)).toEqual({ kind: "file", input: { file: "/tmp/secret.txt", key: "encrypt", out: "/tmp/secret.ocsec" } })
  } finally {
    app.renderer.destroy()
  }
})

test("reports empty input and missing keys without opening a panel", async () => {
  const empty = createHarness()
  const emptyApp = await render(empty)
  try {
    command(empty, "Encrypt sensitive data")
    await waitFor(emptyApp, () => emptyApp.captureCharFrame().includes("Type any text to encrypt"), "encryption panel did not open")
    command(empty, "Encrypt")
    await waitFor(emptyApp, () => empty.toasts.includes("Text cannot be empty"), "empty text warning was not shown")
  } finally {
    emptyApp.renderer.destroy()
  }

  const missing = createHarness({ keys: [] })
  const missingApp = await render(missing)
  try {
    command(missing, "Encrypt sensitive data")
    await waitFor(missingApp, () => missing.toasts.includes("No encryption key is available"), "missing key warning was not shown")
    expect(missingApp.captureCharFrame()).not.toContain("Type any text to encrypt")
  } finally {
    missingApp.renderer.destroy()
  }
})

test("does not register when encryption is disabled", () => {
  const harness = createHarness({ enabled: false })
  expect(harness.layers).toEqual([])
})
