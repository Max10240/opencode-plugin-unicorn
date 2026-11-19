import { Plugin } from "@opencode/plugin/tui"
import type { Context } from "@opencode/plugin/tui/context"
import { TextAttributes } from "@opentui/core"
import { createSignal, onMount, Show } from "solid-js"
import { RecommendedStatusRpc } from "./rpc.js"
import type { RecommendedStatus } from "./status.js"

export const COMMAND_ID = "max10240.recommended-opencode-config.status"
export const SLASH_NAME = "recommended"

export default Plugin.define({
  id: "max10240.recommended-opencode-config.tui",
  setup: setupRecommendedConfigTui,
})

export function setupRecommendedConfigTui(context: Context) {
  context.keymap.layer(() => ({
    mode: "global",
    priority: 10,
    commands: [{
      id: COMMAND_ID,
      title: "Recommended config status",
      description: "Show recommended rules, commands, and which ones are missing",
      group: "Config",
      bind: false,
      palette: true,
      slash: { name: SLASH_NAME },
      run: () => openRecommendedStatus(context),
    }],
  }))
}

export function openRecommendedStatus(context: Context) {
  context.ui.dialog.show(() => <RecommendedStatusDialog context={context} />)
}

export function RecommendedStatusDialog(props: { context: Context }) {
  const theme = props.context.theme.surface("dialog")
  const [status, setStatus] = createSignal<RecommendedStatus>()
  const [error, setError] = createSignal<string>()
  const [loading, setLoading] = createSignal(true)
  const [help, setHelp] = createSignal(false)

  props.context.keymap.layer(() => ({
    mode: "modal",
    priority: 20,
    commands: [
      { bind: "r", title: "Refresh recommended status", run: () => void load() },
      { bind: "?", title: "Toggle recommended help", run: () => setHelp((value) => !value) },
      { bind: "escape", title: "Close recommended status", run: () => {
        if (help()) setHelp(false)
        else props.context.ui.dialog.clear()
      } },
    ],
  }))

  const load = async () => {
    setLoading(true)
    setError(undefined)
    try {
      setStatus(await props.context.client.rpc(RecommendedStatusRpc).status({}, { location: props.context.location }) as RecommendedStatus)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Recommended config status is unavailable")
    } finally {
      setLoading(false)
    }
  }

  onMount(() => {
    props.context.ui.dialog.set({ size: "large", centered: true })
    void load()
  })

  const missing = (values: readonly string[]) => values.length ? values.join(", ") : "none"

  return (
    <box paddingLeft={2} paddingRight={2} gap={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text attributes={TextAttributes.BOLD} fg={theme.text.base}>Recommended config</text>
        <text fg={theme.text.muted}>{loading() ? "loading…" : "? help · r refresh · esc close"}</text>
      </box>
      <Show when={help()}>
        <box flexDirection="column" paddingLeft={1} paddingRight={1} backgroundColor={theme.background.raised.high}>
          <text attributes={TextAttributes.BOLD} fg={theme.text.base}>Keyboard help</text>
          <text fg={theme.text.muted}>Rules and commands are applied automatically at startup when enabled.</text>
          <text fg={theme.text.muted}>This panel only reports what is present and what is missing.</text>
          <text fg={theme.text.muted}>R refreshes the status. ? closes help.</text>
        </box>
      </Show>
      <text fg={theme.text.muted}>Read-only status. Configuration changes are made by the plugin at startup.</text>
      <Show when={status()}>
        {(value) => <text fg={theme.text.base}>{`Automatic updates: ${value().enabled ? "enabled" : "disabled"}`}</text>}
      </Show>
      <Show when={error()}>
        {(message) => <text fg={theme.text.feedback?.error?.base ?? theme.text.base} wrapMode="word">{message()}</text>}
      </Show>
      <Show when={status()}>
        {(value) => (
          <>
            <text fg={theme.text.muted} wrapMode="word">{`Config directory: ${value().directory}`}</text>
            <text fg={theme.text.muted} wrapMode="word">{`Config files: ${value().configFiles.length ? value().configFiles.join(", ") : "none"}`}</text>
            <text fg={theme.text.base}>{`Rules: ${value().rules.present}/${value().rules.total} present`}</text>
            <text fg={theme.text.muted} wrapMode="word">{`Missing rules: ${missing(value().rules.missing)}`}</text>
            <text fg={theme.text.base}>{`Commands: ${value().commands.present.length}/${value().commands.total} present`}</text>
            <text fg={theme.text.muted} wrapMode="word">{`Missing commands: ${missing(value().commands.missing)}`}</text>
          </>
        )}
      </Show>
    </box>
  )
}
