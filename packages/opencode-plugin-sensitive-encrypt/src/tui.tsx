import { Plugin } from "@opencode/plugin/tui"
import type { Context } from "@opencode/plugin/tui/context"
import { TextAttributes, type BoxRenderable, type InputRenderable, type TextareaRenderable } from "@opentui/core"
import { createSignal, onCleanup, onMount, Show } from "solid-js"
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
  const theme = props.context.theme.surface("dialog")
  const [mode, setMode] = createSignal<EncryptMode>("text")
  const [textValue, setTextValue] = createSignal("")
  const [concealed, setConcealed] = createSignal(true)
  const [textLength, setTextLength] = createSignal(0)
  const [cursorOffset, setCursorOffset] = createSignal(0)
  const [help, setHelp] = createSignal(false)
  const [keyRole, setKeyRole] = createSignal<KeyRole>(props.defaultKey)
  const [textarea, setTextarea] = createSignal<TextareaRenderable>()
  const [fileInput, setFileInput] = createSignal<InputRenderable>()
  const [outInput, setOutInput] = createSignal<InputRenderable>()
  const [keyTarget, setKeyTarget] = createSignal<BoxRenderable>()
  const [keyFocused, setKeyFocused] = createSignal(false)
  const primary = () => mode() === "text" ? textarea() : fileInput()
  const key = () => props.keys.find((item) => item.role === keyRole()) ?? props.keys[0]
  const keyTextColor = () => props.keys.length > 1 && !keyFocused() ? theme.text.muted : theme.text.base
  const formBackground = theme.background?.formfield?.base ?? theme.background?.base
  const formFocusedBackground = theme.background?.formfield?.focused ?? theme.background?.raised?.high
  const formFocusedText = theme.text?.formfield?.focused ?? theme.text.formfield.base

  let lengthTimer: ReturnType<typeof setInterval> | undefined

  const syncText = () => {
    const area = textarea()
    if (!area) return
    const value = area.plainText
    setTextValue(value)
    setTextLength(value.length)
    setCursorOffset(area.cursorOffset)
  }

  const maskedText = () => {
    const value = textValue()
    if (!value) return ""
    const masked = value.replace(/[^\n]/g, "*")
    const offset = Math.max(0, Math.min(masked.length, cursorOffset()))
    return `${masked.slice(0, offset)}▏${masked.slice(offset)}`
  }

  const insertNewline = () => {
    const area = textarea()
    if (!area) return
    area.newLine()
    syncText()
  }

  onMount(() => {
    props.context.ui.dialog.set({ size: "large", centered: true })
    setTimeout(() => primary()?.focus(), 50)
    lengthTimer = setInterval(() => {
      if (mode() === "text") syncText()
    }, 300)
  })

  onCleanup(() => {
    if (lengthTimer !== undefined) clearInterval(lengthTimer)
  })

  const toggleConcealed = () => {
    if (mode() !== "text") return
    setConcealed((value) => !value)
    syncText()
    setTimeout(() => textarea()?.focus(), 0)
  }

  const focusPrimary = () => {
    setKeyFocused(false)
    setTimeout(() => primary()?.focus(), 0)
  }

  const focusKey = () => {
    if (props.keys.length > 1) {
      setKeyFocused(true)
      keyTarget()?.focus()
    } else {
      focusPrimary()
    }
  }

  const focusOutput = () => {
    setKeyFocused(false)
    outInput()?.focus()
  }

  const cycleKey = (delta: number) => {
    if (props.keys.length < 2) return
    const index = Math.max(0, props.keys.findIndex((item) => item.role === keyRole()))
    setKeyRole(props.keys[(index + delta + props.keys.length) % props.keys.length]!.role)
  }

  const toggleMode = () => {
    if (mode() === "text") syncText()
    const next: EncryptMode = mode() === "text" ? "file" : "text"
    setMode(next)
    setKeyFocused(false)
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
      if (mode() === "text") {
        textarea()?.setText("")
        setTextValue("")
        setTextLength(0)
        setCursorOffset(0)
      }
      props.context.ui.dialog.clear()
      props.context.ui.dialog.show(() => <EncryptResultDialog context={props.context} result={result} cleared={mode() === "text"} />)
    } catch (error) {
      void props.context.ui.toast.show({
        message: error instanceof Error ? error.message : "Unable to encrypt",
        variant: "error",
      })
    }
  }

  const commands = () => [
    { bind: "f2", title: "Encrypt", run: encrypt },
    { bind: "return", title: "Encrypt", run: encrypt },
    { bind: "ctrl+t", title: "Switch text or file", run: toggleMode },
    ...(mode() === "text" ? [
      { bind: "ctrl+r", title: "Reveal or hide text", run: toggleConcealed },
      { bind: "shift+return", title: "Insert new line", run: insertNewline },
    ] : []),
    { bind: "f1", title: "Toggle encrypt help", run: () => setHelp((value) => !value) },
    { bind: "escape", title: "Close encryption panel", run: () => {
      if (help()) setHelp(false)
      else props.context.ui.dialog.clear()
    } },
  ]

  props.context.keymap.layer(() => ({
    mode: "modal",
    target: primary,
    priority: 20,
    commands: [
      ...commands(),
      { bind: "tab", title: "Focus ciphertext output", run: focusOutput },
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
        <text>f1 help · esc close</text>
      </box>
      <Show when={help()}>
        <box flexDirection="column" paddingLeft={1} paddingRight={1} backgroundColor={theme.background.raised.high}>
          <text attributes={TextAttributes.BOLD}>Keyboard help</text>
          <text fg={theme.text.muted}>Enter encrypts; Shift+Enter inserts a new line.</text>
          <text fg={theme.text.muted}>F2 also encrypts the current text or file.</text>
          <text fg={theme.text.muted}>Ctrl+T switches between text and file input.</text>
          <text fg={theme.text.muted}>Ctrl+R hides or reveals the text being encrypted.</text>
          <text fg={theme.text.muted}>Tab moves focus between input, output, and key.</text>
          <text fg={theme.text.muted}>F1 closes help. Esc closes help first, then the panel.</text>
        </box>
      </Show>
      <text>
        {mode() === "text" ? "[Text]" : "Text"}  {mode() === "file" ? "[File]" : "File"}  ctrl+t switch
      </text>
      <Show
        when={mode() === "text"}
        fallback={
          <box onMouseUp={() => setKeyFocused(false)}>
            <input
              ref={(value: InputRenderable) => { setFileInput(value); setTimeout(() => value.focus(), 0) }}
              placeholder="$TMPDIR/secret.txt"
              backgroundColor={formBackground}
              focusedBackgroundColor={formFocusedBackground}
              textColor={theme.text.formfield.base}
              focusedTextColor={formFocusedText}
              cursorColor={theme.text.formfield.base}
            />
          </box>
        }
      >
        <box flexDirection="column" gap={0} onMouseUp={() => setKeyFocused(false)}>
          <textarea
            ref={(value: TextareaRenderable) => { setTextarea(value); setTimeout(() => value.focus(), 0) }}
            initialValue={textValue()}
            height={concealed() ? 1 : 8}
            wrapMode="word"
            placeholder="Type any text to encrypt…"
            backgroundColor={concealed() ? theme.background.raised.high : formBackground}
            focusedBackgroundColor={concealed() ? theme.background.raised.high : formFocusedBackground}
            textColor={concealed() ? theme.background.raised.high : theme.text.formfield.base}
            focusedTextColor={concealed() ? theme.background.raised.high : formFocusedText}
            cursorColor={theme.text.formfield.base}
            showCursor={!concealed()}
            onContentChange={syncText}
            onCursorChange={syncText}
          />
          <Show when={concealed()}>
            <box
              paddingLeft={1}
              paddingRight={1}
              minHeight={1}
              backgroundColor={theme.background.raised.high}
              onMouseUp={() => textarea()?.focus()}
            >
              <Show when={textValue().length > 0} fallback={<text fg={theme.text.muted}>Type any text to encrypt…</text>}>
                <text fg={theme.text.formfield.base} wrapMode="word">{maskedText()}</text>
              </Show>
            </box>
          </Show>
          <text fg={theme.text.muted}>
            {`${concealed() ? "Masked" : "Visible"} · ${textLength()} ${textLength() === 1 ? "character" : "characters"} · ctrl+r ${concealed() ? "reveal" : "hide"}`}
          </text>
        </box>
      </Show>
      <box onMouseUp={() => setKeyFocused(false)}>
        <input
          ref={(value: InputRenderable) => { setOutInput(value) }}
          placeholder="Ciphertext output (optional, under $TMPDIR)"
          backgroundColor={formBackground}
          focusedBackgroundColor={formFocusedBackground}
          textColor={theme.text.formfield.base}
          focusedTextColor={formFocusedText}
          cursorColor={theme.text.formfield.base}
        />
      </box>
      <box
        ref={(value: BoxRenderable) => setKeyTarget(value)}
        focusable={props.keys.length > 1}
        backgroundColor={keyFocused() ? theme.background.raised.high : undefined}
        onMouseUp={() => {
          if (props.keys.length > 1) {
            setKeyFocused(true)
            keyTarget()?.focus()
          }
        }}
      >
        <text fg={keyTextColor()}>
          Key: {keyRole() === "decrypt" ? "Decrypt" : "Encrypt"} ({key()?.keyID.slice(0, 8)}…) {props.keys.length > 1 ? "· tab focus, left/right change" : ""}
        </text>
      </box>
      <text fg={theme.text.muted} wrapMode="word">enter/f2 encrypt · shift+enter newline · ctrl+t text/file · {mode() === "text" ? "ctrl+r reveal/hide · " : ""}tab output/key · f1 help</text>
    </box>
  )
}

function EncryptResultDialog(props: { context: Context; result: EncryptResult; cleared?: boolean }) {
  const copy = (value: string | undefined, label: string) => {
    if (!value) return false
    if (!props.context.renderer.copyToClipboardOSC52(value)) {
      void props.context.ui.toast.show({ message: `Could not copy ${label}`, variant: "error" })
      return false
    }
    void props.context.ui.toast.show({ message: `Copied ${label}`, variant: "info" })
    return true
  }

  const copyAndClose = () => {
    if (copy(props.result.ciphertext ?? props.result.out, "ciphertext")) props.context.ui.dialog.clear()
  }

  const [target, setTarget] = createSignal<BoxRenderable>()
  props.context.keymap.layer(() => ({
    mode: "modal",
    target,
    priority: 20,
    commands: [
      { bind: "return", title: "Copy ciphertext and close", run: copyAndClose },
      { bind: "c", title: "Copy ciphertext", run: () => copy(props.result.ciphertext ?? props.result.out, "ciphertext") },
      { bind: "ctrl+y", title: "Copy ciphertext", run: () => copy(props.result.ciphertext ?? props.result.out, "ciphertext") },
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
      <Show when={props.cleared}>
        <text>Plaintext input cleared.</text>
      </Show>
      <Show when={props.result.out}>
        <text>Output: {props.result.out}</text>
      </Show>
      <Show when={ciphertext()}>
        <scrollbox height={18} minHeight={0} viewportOptions={{ paddingRight: 1 }}>
          <text wrapMode="word">{shown()}</text>
        </scrollbox>
      </Show>
      <text>enter copy + close · c / ctrl+y copy · p: copy output path · Esc: close</text>
    </box>
  )
}
