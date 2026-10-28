import { Plugin } from "@opencode/plugin/tui"
import type { Context } from "@opencode/plugin/tui/context"
import { useKeyboard } from "@opentui/solid"
import { Show } from "solid-js"
import { EncryptPreview } from "./rpc.js"

type EncryptResult = {
  ciphertext?: string
  out?: string
  keyID: string
  bytes: number
}

export default Plugin.define({
  id: "max10240.sensitive-encrypt.tui",
  setup: setupSensitiveEncryptTui,
})

export function setupSensitiveEncryptTui(context: Context) {
  const options = context.options
  if (options.enabled === false || options.encrypt === false || options.encrypt === null) return
  context.keymap.layer(() => ({
    commands: [{
      id: "sensitive-encrypt.encrypt",
      title: "Encrypt sensitive file",
      description: "Encrypt a file under $TMPDIR with the configured public key",
      group: "Sensitive",
      bind: false,
      palette: true,
      slash: { name: "encrypt-sensitive" },
      run: () => runEncrypt(context),
    }],
  }))
}

async function runEncrypt(context: Context) {
  const file = await context.ui.dialog.prompt({
    title: "Encrypt sensitive file",
    description: "Input file under $TMPDIR",
    placeholder: "$TMPDIR/secret.txt",
  })
  if (!file?.trim()) return

  const out = await context.ui.dialog.prompt({
    title: "Ciphertext output (optional)",
    description: "Leave empty to show the ciphertext in the result dialog",
    placeholder: "$TMPDIR/secret.ocsec",
  })

  context.ui.dialog.clear()
  try {
    const result = await context.client.rpc(EncryptPreview).encrypt(
      { file: file.trim(), ...(out?.trim() ? { out: out.trim() } : {}) },
      { location: context.location },
    ) as EncryptResult
    context.ui.dialog.show(() => <EncryptResultDialog context={context} result={result} />)
  } catch (error) {
    await context.ui.dialog.alert({
      title: "Encryption failed",
      message: error instanceof Error ? error.message : "Unable to encrypt this file",
    })
  }
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

  useKeyboard((event) => {
    if (event.name === "c") {
      event.preventDefault()
      event.stopPropagation()
      copy(props.result.ciphertext ?? props.result.out, "ciphertext")
    } else if (event.name === "p") {
      event.preventDefault()
      event.stopPropagation()
      copy(props.result.out, "output path")
    }
  })

  const ciphertext = () => props.result.ciphertext ?? ""
  const shown = () => ciphertext().length > 20_000 ? `${ciphertext().slice(0, 20_000)}\n…` : ciphertext()

  return (
    <box flexDirection="column" gap={1}>
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
