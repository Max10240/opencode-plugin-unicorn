import { TextAttributes, type InputRenderable, type ScrollBoxRenderable } from "@opentui/core"
import type { JSX } from "solid-js"
import { For, Show } from "solid-js"
import type { MatchRange } from "./query.js"

export type UiTheme = any

export function DialogFrame(props: {
  theme: UiTheme
  title: string
  meta?: string
  children: JSX.Element
  footer?: JSX.Element
}) {
  return (
    <box paddingLeft={2} paddingRight={2} gap={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text attributes={TextAttributes.BOLD} fg={props.theme.text.base}>{props.title}</text>
        <text fg={props.theme.text.muted}>{props.meta ?? "esc close"}</text>
      </box>
      {props.children}
      <Show when={props.footer}>
        <box>{props.footer}</box>
      </Show>
    </box>
  )
}

export function SearchField(props: {
  theme: UiTheme
  inputRef?: (value: InputRenderable) => void
  value?: string
  placeholder: string
  onInput: (value: string) => void
  onSubmit?: () => void
}) {
  return (
    <input
      ref={props.inputRef}
      value={props.value}
      onInput={props.onInput}
      onSubmit={props.onSubmit}
      placeholder={props.placeholder}
      placeholderColor={props.theme.text.muted}
      textColor={props.theme.text.formfield.base}
      focusedTextColor={props.theme.text.formfield.base}
      cursorColor={props.theme.text.formfield.base}
    />
  )
}

export function ResultList(props: {
  theme: UiTheme
  listRef?: (value: ScrollBoxRenderable) => void
  when: boolean
  empty: string
  children: JSX.Element
}) {
  return (
    <scrollbox ref={props.listRef} focusable maxHeight={18} scrollbarOptions={{ visible: false }}>
      <Show when={props.when} fallback={<EmptyState theme={props.theme} message={props.empty} />}>
        {props.children}
      </Show>
    </scrollbox>
  )
}

export function FooterHints(props: { theme: UiTheme; children: JSX.Element }) {
  return <text fg={props.theme.text.muted}>{props.children}</text>
}

export function EmptyState(props: { theme: UiTheme; message: string }) {
  return <text fg={props.theme.text.muted} wrapMode="word">{props.message}</text>
}

export function NoticeLine(props: { theme: UiTheme; message: string; variant?: "info" | "success" | "error" }) {
  const color = () =>
    props.variant === "error"
      ? props.theme.text.feedback?.error?.base ?? props.theme.text.base
      : props.variant === "success"
        ? props.theme.text.feedback?.success?.base ?? props.theme.text.base
        : props.theme.text.feedback?.info?.base ?? props.theme.text.muted
  return <text fg={color()} wrapMode="word">{props.message}</text>
}

export function HighlightText(props: {
  theme: UiTheme
  text: string
  ranges: readonly MatchRange[]
  muted?: boolean
  wrapMode?: "none" | "word"
  truncate?: boolean
}) {
  const segments = () => {
    const parts: Array<{ text: string; highlight: boolean }> = []
    let cursor = 0
    for (const range of props.ranges) {
      if (range.start > cursor) parts.push({ text: props.text.slice(cursor, range.start), highlight: false })
      parts.push({ text: props.text.slice(range.start, range.end), highlight: true })
      cursor = range.end
    }
    if (cursor < props.text.length) parts.push({ text: props.text.slice(cursor), highlight: false })
    return parts.length ? parts : [{ text: props.text, highlight: false }]
  }
  return (
    <text fg={props.muted ? props.theme.text.muted : props.theme.text.base} wrapMode={props.wrapMode ?? "word"} truncate={props.truncate}>
      <For each={segments()}>
        {(segment) => (
          <span style={segment.highlight ? { fg: props.theme.text.feedback?.warning?.base ?? props.theme.text.base, attributes: TextAttributes.BOLD } : {}}>
            {segment.text}
          </span>
        )}
      </For>
    </text>
  )
}

export function HelpPanel(props: { theme: UiTheme; lines: readonly string[] }) {
  return (
    <box flexDirection="column" gap={0} paddingLeft={1} paddingRight={1} backgroundColor={props.theme.background.raised.high}>
      <text fg={props.theme.text.base} attributes={TextAttributes.BOLD}>Keyboard help</text>
      <For each={props.lines}>{(line) => <text fg={props.theme.text.muted}>{line}</text>}</For>
      <text fg={props.theme.text.muted}>?/f1 close help · esc close</text>
    </box>
  )
}

export function formatRelative(timestamp: number, now = Date.now()) {
  if (!Number.isFinite(timestamp) || timestamp <= 0) return "unknown time"
  const seconds = Math.max(0, Math.floor((now - timestamp) / 1000))
  if (seconds < 45) return "just now"
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${Math.max(1, minutes)}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days === 1) return "yesterday"
  if (days < 30) return `${days}d ago`
  return new Date(timestamp).toLocaleDateString("en-US", { month: "short", day: "numeric" })
}
