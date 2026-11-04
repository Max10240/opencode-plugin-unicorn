import { Plugin } from "@opencode/plugin/tui"
import type { Context } from "@opencode/plugin/tui/context"
import { TextAttributes, type BoxRenderable, type InputRenderable, type TextareaRenderable } from "@opentui/core"
import { createSignal, onMount, Show } from "solid-js"
import { EncryptPreview } from "./rpc.js"

type EncryptResult = {
  ciphertext?: string
  out?: string
  keyID: string
  bytes: number
}

type EncryptMode = "text" | "file"
type KeyRole = "decrypt" | "encrypt"
type KeyInfo = { role: KeyRole; keyID: string }
type KeyResult = { keys: KeyInfo[]; defaultRole: KeyRole }

export default Plugin.define({
  id: "max10240.sensitive-encrypt.tui",
  setup: setupSensitiveEncryptTui,
})

export function setupSensitiveEncryptTui(context: Context) {
  const options = context.options
  if (options.enabled === false || options.encrypt === false || options.encrypt === null) return
  context.keymap.layer(() => ({
    mode: "global",
    commands: [{
      id: "sensitive-encrypt.encrypt",
      title: "Encrypt sensitive data",
      description: "Encrypt in-memory text or a file with the configured public key",
      group: "Sensitive",
      bind: false,
      palette: true,
      slash: { name: "encrypt-sensitive" },
      run: () => openEncryptPanel(context),
    }],
  }))
}

async function openEncryptPanel(context: Context) {
  try {
    const result = await context.client.rpc(EncryptPreview).keys({}, { location: context.location }) as KeyResult
    if (result.keys.length === 0) {
      void context.ui.toast.show({ message: "No encryption key is available", variant: "error" })
      return
    }
    context.ui.dialog.show(() => <EncryptPanel context={context} keys={result.keys} defaultKey={result.defaultRole} />)
  } catch (error) {
    void context.ui.toast.show({
      message: error instanceof Error ? error.message : "Unable to load encryption keys",
      variant: "error",
    })
  }
}

function EncryptPanel(props: { context: Context; keys: KeyInfo[]; defaultKey: KeyRole }) {
  const [mode, setMode] = createSignal<EncryptMode>("text")
  const [textValue, setTextValue] = createSignal("")
  const [keyRole, setKeyRole] = createSignal<KeyRole>(props.defaultKey)
  const [textarea, setTextarea] = createSignal<TextareaRenderable>()
  const [fileInput, setFileInput] = createSignal<InputRenderable>()
  const [outInput, setOutInput] = createSignal<InputRenderable>()
  const [keyTarget, setKeyTarget] = createSignal<BoxRenderable>()
  const primary = () => mode() === "text" ? textarea() : fileInput()
  const key = () => props.keys.find((item) => item.role === keyRole()) ?? props.keys[0]

  onMount(() => {
    props.context.ui.dialog.set({ size: "large", centered: true })
    setTimeout(() => primary()?.focus(), 50)
  })

  const focusPrimary = () => {
    setTimeout(() => primary()?.focus(), 0)
  }

  const focusKey = () => {
    if (props.keys.length > 1) keyTarget()?.focus()
    else focusPrimary()
  }

  const cycleKey = (delta: number) => {
    if (props.keys.length < 2) return
    const index = Math.max(0, props.keys.findIndex((item) => item.role === keyRole()))
    setKeyRole(props.keys[(index + delta + props.keys.length) % props.keys.length]!.role)
  }

  const toggleMode = () => {
    if (mode() === "text") setTextValue(textarea()?.plainText ?? "")
    const next: EncryptMode = mode() === "text" ? "file" : "text"
    setMode(next)
    setTimeout(() => (next === "text" ? textarea() : fileInput())?.focus(), 0)
  }

  const encrypt = async () => {
    const out = outInput()?.value.trim()
    try {
      let result: EncryptResult
      if (mode() === "text") {
        const text = textarea()?.plainText ?? ""
        if (!text.length) {
          void props.context.ui.toast.show({ message: "Text cannot be empty", variant: "warning" })
          return
        }
        result = await props.context.client.rpc(EncryptPreview).encryptText(
          { text, key: keyRole(), ...(out ? { out } : {}) },
          { location: props.context.location },
        ) as EncryptResult
      } else {
        const file = fileInput()?.value.trim()
        if (!file) {
          void props.context.ui.toast.show({ message: "File path is required", variant: "warning" })
          return
        }
        result = await props.context.client.rpc(EncryptPreview).encrypt(
          { file, key: keyRole(), ...(out ? { out } : {}) },
          { location: props.context.location },
        ) as EncryptResult
      }
      props.context.ui.dialog.clear()
      props.context.ui.dialog.show(() => <EncryptResultDialog context={props.context} result={result} />)
    } catch (error) {
      void props.context.ui.toast.show({
        message: error instanceof Error ? error.message : "Unable to encrypt",
        variant: "error",
      })
    }
  }

  const commands = () => [
    { bind: "f2", title: "Encrypt", run: encrypt },
    { bind: "ctrl+t", title: "Switch text or file", run: toggleMode },
    { bind: "escape", title: "Close encryption panel", run: () => props.context.ui.dialog.clear() },
  ]

  props.context.keymap.layer(() => ({
    mode: "modal",
    target: primary,
    priority: 20,
    commands: [
      ...commands(),
      { bind: "tab", title: "Focus ciphertext output", run: () => outInput()?.focus() },
    ],
  }))
  props.context.keymap.layer(() => ({
    mode: "modal",
    target: outInput,
    priority: 20,
    commands: [
      ...commands(),
      { bind: "tab", title: "Focus encryption key", run: focusKey },
    ],
  }))
  props.context.keymap.layer(() => ({
    mode: "modal",
    target: keyTarget,
    priority: 20,
    commands: [
      ...commands(),
      { bind: "left", title: "Previous encryption key", run: () => cycleKey(-1) },
      { bind: "right", title: "Next encryption key", run: () => cycleKey(1) },
      { bind: "space", title: "Next encryption key", run: () => cycleKey(1) },
      { bind: "tab", title: "Focus text or file input", run: focusPrimary },
    ],
  }))

  return (
    <box paddingLeft={2} paddingRight={2} gap={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text attributes={TextAttributes.BOLD}>Encrypt sensitive data</text>
        <text>esc close</text>
      </box>
      <text>
        {mode() === "text" ? "[Text]" : "Text"}  {mode() === "file" ? "[File]" : "File"}  ctrl+t switch
      </text>
      <Show
        when={mode() === "text"}
        fallback={
          <input
            ref={(value: InputRenderable) => { setFileInput(value); setTimeout(() => value.focus(), 0) }}
            placeholder="$TMPDIR/secret.txt"
          />
        }
      >
        <textarea
          ref={(value: TextareaRenderable) => { setTextarea(value); setTimeout(() => value.focus(), 0) }}
          initialValue={textValue()}
          height={8}
          wrapMode="word"
          placeholder="Type any text to encrypt…"
        />
      </Show>
      <input
        ref={(value: InputRenderable) => { setOutInput(value) }}
        placeholder="Ciphertext output (optional, under $TMPDIR)"
      />
      <box ref={(value: BoxRenderable) => setKeyTarget(value)} focusable={props.keys.length > 1}>
        <text>
          Key: {keyRole() === "decrypt" ? "Decrypt" : "Encrypt"} ({key()?.keyID.slice(0, 8)}…) {props.keys.length > 1 ? "· tab focus, left/right change" : ""}
        </text>
      </box>
      <text>f2 encrypt · ctrl+t text/file · tab output/key · esc close</text>
    </box>
  )
}

function EncryptResultDialog(props: { context: Context; result: EncryptResult }) {
  const copy = (value: string | undefined, label: string) => {
    if (!value) return
    if (!props.context.renderer.copyToClipboardOSC52(value)) {
      void props.context.ui.toast.show({ message: `Could not copy ${label}`, variant: "error" })
      return
    }
    void props.context.ui.toast.show({ message: `Copied ${label}`, variant: "info" })
  }

  const [target, setTarget] = createSignal<BoxRenderable>()
  props.context.keymap.layer(() => ({
    mode: "modal",
    target,
    priority: 20,
    commands: [
      { bind: "c", title: "Copy ciphertext", run: () => copy(props.result.ciphertext ?? props.result.out, "ciphertext") },
      { bind: "p", title: "Copy output path", run: () => copy(props.result.out, "output path") },
    ],
  }))

  const ciphertext = () => props.result.ciphertext ?? ""
  const shown = () => ciphertext().length > 20_000 ? `${ciphertext().slice(0, 20_000)}\n…` : ciphertext()

  return (
    <box
      ref={(value: BoxRenderable) => {
        setTarget(value)
        setTimeout(() => {
          if (!value.isDestroyed) value.focus()
        }, 0)
      }}
      focusable
      flexDirection="column"
      gap={1}
    >
      <text>Encrypted with key {props.result.keyID}</text>
      <text>{props.result.bytes} ciphertext bytes</text>
      <Show when={props.result.out}>
        <text>Output: {props.result.out}</text>
      </Show>
      <Show when={ciphertext()}>
        <scrollbox height={18} minHeight={0} viewportOptions={{ paddingRight: 1 }}>
          <text wrapMode="word">{shown()}</text>
        </scrollbox>
      </Show>
      <text>c: copy ciphertext / p: copy output path / Esc: close</text>
    </box>
  )
}
