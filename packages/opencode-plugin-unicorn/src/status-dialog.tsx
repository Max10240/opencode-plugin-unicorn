import type { Context } from "@opencode/plugin/tui/context"
import { TextAttributes } from "@opentui/core"
import { createSignal, For, onMount, Show } from "solid-js"
import { COMMAND_ID as NOTEPAD_COMMAND } from "@max10240/opencode-plugin-notepad/tui"
import { COMMAND_ID as PROMPT_SEARCH_COMMAND } from "@max10240/opencode-plugin-prompt-search/tui"
import { COMMAND_ID as SESSION_SEARCH_COMMAND } from "@max10240/opencode-plugin-session-search/tui"
import { COMMAND_ID as GO_USAGE_COMMAND } from "@max10240/opencode-plugin-opencode-go-usage/tui"
import { COMMAND_ID as RECOMMENDED_COMMAND } from "@max10240/opencode-plugin-recomended-opencode-config/tui"
import { HISTORY_COMMAND_ID } from "@max10240/opencode-plugin-sensitive-protection/tui"
import {
  COMMAND_ID as INFINITE_LOOP_COMMAND,
  OVERVIEW_COMMAND_ID as INFINITE_LOOPS_COMMAND,
} from "@max10240/opencode-plugin-infinite-loop/tui"
import type { UnicornRuntimeStatus } from "./status.js"
import { UnicornStatusRpc } from "./status-rpc.js"
import { godFeatureEnabled, recommendedConfigFeatureOption } from "./options.js"

export const UNICORN_STATUS_COMMAND_ID = "max10240.unicorn.status.open"
export const UNICORN_STATUS_SLASH = "unicorn"

type FeatureRow = { name: string; enabled: boolean; note: string; reason?: string }

export function unicornStatusCommand(context: Context) {
  context.keymap.layer(() => ({
    mode: "global",
    priority: 10,
    commands: [{
      id: UNICORN_STATUS_COMMAND_ID,
      title: "Unicorn status",
      description: "Show feature switches, keybinds, defaults, versions, and shadow status",
      group: "Unicorn",
      bind: false,
      palette: true,
      slash: { name: UNICORN_STATUS_SLASH },
      run: () => openUnicornStatus(context),
    }],
  }))
}

export function openUnicornStatus(context: Context) {
  context.ui.dialog.show(() => <UnicornStatusDialog context={context} />)
}

function UnicornStatusDialog(props: { context: Context }) {
  const theme = props.context.theme.surface("dialog")
  const [runtime, setRuntime] = createSignal<UnicornRuntimeStatus>()
  const [error, setError] = createSignal<string>()
  const [loading, setLoading] = createSignal(true)
  const [help, setHelp] = createSignal(false)
  const options = props.context.options
  const features = () => [
    feature("Prompt search", !isFalse(options.features, "promptSearch"), "all prompts across sessions", "features.promptSearch=false"),
    feature("Session search", !isFalse(options.features, "sessionSearch"), "current session transcript", "features.sessionSearch=false"),
    feature("Notepad", !isFalse(options.features, "notepad"), "folder and global notes", "features.notepad=false"),
    feature("Image previews", !isFalse(options.features, "showImg"), "inline tool image previews", "features.showImg=false"),
    feature("Sensitive protection", !isFalse(options.features, "sensitiveProtection"), "redacts protected files", "features.sensitiveProtection=false"),
    feature("Sensitive encrypt", !isFalse(options.features, "sensitiveEncrypt"), "encrypt text or files", "features.sensitiveEncrypt=false"),
    feature("OpenCode Go usage", !isFalse(options.features, "opencodeGoUsage"), "account limits", "features.opencodeGoUsage=false"),
    feature("Non-blocking", !isFalse(options.features, "nonBlocking"), "background long tasks", "features.nonBlocking=false"),
    feature("Image gen", !isFalse(options.features, "imageGen"), "agent image generation", "features.imageGen=false"),
    feature("Send message", !isFalse(options.features, "sendMessageAcrossSessions"), "cross-session messaging", "features.sendMessageAcrossSessions=false"),
    feature("Recommended config", recommendedConfigFeatureOption(options) !== false, "rules and commands", "features.recommendedOpencodeConfig=false"),
    feature("God agent", godFeatureEnabled(options), "opt-in prompt override", "enable features.god or provide god options"),
    feature("Infinite loop", !isFalse(options.features, "infiniteLoop"), "idle nudges for activated sessions", "features.infiniteLoop=false"),
    feature("Delayed queue", !isFalse(options.features, "delayedQueue"), "idle-gated message queue", "features.delayedQueue=false"),
  ]
  const defaults = () => [
    `Prompt search scope: ${options.promptSearch?.defaultScope === "project" ? "current project" : "all projects"}`,
    `Session search role: ${options.sessionSearch?.defaultIncludeAgent === true ? "user + agent" : "user only"}`,
    `Notepad sort: ${options.notepad?.defaultSort === "created" ? "created" : "updated"}`,
    "Last scope, role, and sort choices are remembered per plugin.",
  ]
  const binds = () => {
    const rows = [
      commandRow(props.context, "Prompt search", PROMPT_SEARCH_COMMAND, optionKeybind(options.promptSearch, "Ctrl+Shift+R")),
      commandRow(props.context, "Session search", SESSION_SEARCH_COMMAND, optionKeybind(options.sessionSearch, "Ctrl+Shift+F")),
      commandRow(props.context, "Notepad", NOTEPAD_COMMAND, optionKeybind(options.notepad, "Ctrl+Shift+N")),
      commandRow(props.context, "Go usage", GO_USAGE_COMMAND, optionKeybind(options.opencodeGoUsage, "none")),
      commandRow(props.context, "Protection history", HISTORY_COMMAND_ID, optionKeybind(options.sensitiveProtection, "Ctrl+Shift+H", "historyKeybind")),
      commandRow(props.context, "Infinite loop", INFINITE_LOOP_COMMAND, optionKeybind(options.infiniteLoop, "Ctrl+Shift+I")),
      commandRow(props.context, "Infinite loops", INFINITE_LOOPS_COMMAND, optionKeybind(options.infiniteLoop, "Ctrl+Shift+O", "overviewKeybind")),
      commandRow(props.context, "Encrypt", "sensitive-encrypt.encrypt", "none"),
      commandRow(props.context, "Recommended config", RECOMMENDED_COMMAND, "none"),
      commandRow(props.context, "Unicorn status", UNICORN_STATUS_COMMAND_ID, "none"),
    ]
    return rows
  }
  const conflicts = () => {
    const known = new Set([
      PROMPT_SEARCH_COMMAND,
      SESSION_SEARCH_COMMAND,
      NOTEPAD_COMMAND,
      GO_USAGE_COMMAND,
      HISTORY_COMMAND_ID,
      INFINITE_LOOP_COMMAND,
      INFINITE_LOOPS_COMMAND,
      "sensitive-encrypt.encrypt",
      RECOMMENDED_COMMAND,
      UNICORN_STATUS_COMMAND_ID,
    ])
    const byBind = new Map<string, string[]>()
    for (const command of props.context.keymap.commands()) {
      const bind = typeof command.bind === "string" ? command.bind : ""
      if (!command.id || !bind || !known.has(command.id)) continue
      for (const token of bind.split(",")) {
        const value = token.trim()
        if (!value || value === "none") continue
        const list = byBind.get(value) ?? []
        if (!list.includes(command.id)) list.push(command.id)
        byBind.set(value, list)
      }
    }
    return [...byBind].filter(([, commands]) => commands.length > 1).map(([bind, commands]) => `${bind}: ${commands.join(", ")}`)
  }

  const load = async () => {
    setLoading(true)
    setError(undefined)
    try {
      setRuntime(await props.context.client.rpc(UnicornStatusRpc).runtime({}) as UnicornRuntimeStatus)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Runtime status is unavailable")
    } finally {
      setLoading(false)
    }
  }

  props.context.keymap.layer(() => ({
    mode: "modal",
    priority: 20,
    commands: [
      { bind: "r", title: "Refresh unicorn status", run: () => void load() },
      { bind: "?", title: "Toggle unicorn help", run: () => setHelp((value) => !value) },
      { bind: "escape", title: "Close unicorn status", run: () => {
        if (help()) setHelp(false)
        else props.context.ui.dialog.clear()
      } },
    ],
  }))

  onMount(() => {
    props.context.ui.dialog.set({ size: "large", centered: true })
    void load()
  })

  return (
    <box paddingLeft={2} paddingRight={2} gap={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text attributes={TextAttributes.BOLD} fg={theme.text.base}>Unicorn status</text>
        <text fg={theme.text.muted}>{loading() ? "loading…" : "read-only · ? help · r refresh · esc close"}</text>
      </box>
      <Show when={help()}>
        <box flexDirection="column" paddingLeft={1} paddingRight={1} backgroundColor={theme.background.raised.high}>
          <text attributes={TextAttributes.BOLD} fg={theme.text.base}>Keyboard help</text>
          <text fg={theme.text.muted}>Features show the current switch state and why a disabled feature is off.</text>
          <text fg={theme.text.muted}>Keybinds come from the live command registry; conflicts are grouped by binding.</text>
          <text fg={theme.text.muted}>Defaults show the configured starting scope, role, and sort.</text>
          <text fg={theme.text.muted}>R refreshes runtime status. ? closes help.</text>
        </box>
      </Show>
      <text fg={theme.text.muted}>{`OpenCode ${props.context.app.version} (${props.context.app.channel})`}</text>
      <Show when={error()}>
        {(message) => <text fg={theme.text.feedback?.error?.base ?? theme.text.base} wrapMode="word">{message()}</text>}
      </Show>
      <Show when={runtime()}>
        {(value) => (
          <>
            <text fg={theme.text.base}>{`Plugin ${value().version} · ${value().shadow ? "shadow snapshot" : "installed package"}`}</text>
            <Show when={value().commit}>
              {(commit) => <text fg={theme.text.muted}>{`Commit ${commit()}${value().dirty ? " · dirty worktree" : ""}`}</text>}
            </Show>
            <text fg={value().dirty ? theme.text.feedback?.warning?.base ?? theme.text.base : theme.text.muted} wrapMode="word">
              {value().packagePath}
            </text>
          </>
        )}
      </Show>
      <text fg={theme.text.base} attributes={TextAttributes.BOLD}>Features</text>
      <For each={features()}>
        {(row) => (
          <text fg={row.enabled ? theme.text.base : theme.text.muted}>
            {`${row.enabled ? "●" : "○"} ${row.name}${row.enabled ? "" : " (off)"} · ${row.note}${row.reason ? ` · ${row.reason}` : ""}`}
          </text>
        )}
      </For>
      <text fg={theme.text.base} attributes={TextAttributes.BOLD}>Keybinds</text>
      <For each={binds()}>{(row) => <text fg={theme.text.muted}>{`${row.name}: ${row.value}`}</text>}</For>
      <text fg={conflicts().length ? theme.text.feedback?.warning?.base ?? theme.text.base : theme.text.muted}>
        {conflicts().length ? `Potential conflicts: ${conflicts().join(" · ")}` : "No keybind conflicts detected."}
      </text>
      <text fg={theme.text.base} attributes={TextAttributes.BOLD}>Defaults</text>
      <For each={defaults()}>{(line) => <text fg={theme.text.muted}>{line}</text>}</For>
    </box>
  )
}

function feature(name: string, enabled: boolean, note: string, reason?: string): FeatureRow {
  return { name, enabled, note, ...(enabled || !reason ? {} : { reason }) }
}

function isFalse(features: unknown, key: string) {
  return typeof features === "object" && features !== null && (features as Record<string, unknown>)[key] === false
}

function optionKeybind(options: unknown, fallback: string, name = "keybind") {
  if (typeof options !== "object" || options === null) return fallback
  const value = (options as Record<string, unknown>)[name]
  if (value === false) return "none"
  return typeof value === "string" && value.trim() ? value.trim() : fallback
}

function commandRow(context: Context, name: string, id: string, fallback: string) {
  const shortcuts = context.keymap.shortcuts(id)
  return { name, value: shortcuts.length ? shortcuts.join(" / ") : fallback }
}
