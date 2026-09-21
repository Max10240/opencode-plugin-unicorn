import { TextAttributes, type InputRenderable } from "@opentui/core"
import { createEffect, createMemo, createSignal, For, onMount, Show } from "solid-js"
import type { Context } from "@opencode/plugin/tui/context"
import { PromptIndexer, type PromptEntry } from "./indexer.js"

export function PromptSearchDialog(props: { context: Context; indexer: PromptIndexer }) {
  const dialog = props.context.ui.dialog
  const theme = props.context.theme.surface("dialog")
  const [query, setQuery] = createSignal("")
  const [selected, setSelected] = createSignal(0)
  const [inputTarget, setInputTarget] = createSignal<InputRenderable>()
  const results = createMemo(() => props.indexer.search(query()))

  createEffect(() => {
    results()
    setSelected(0)
  })

  const select = async (entry: PromptEntry | undefined) => {
    if (!entry) return
    const route = props.context.ui.router.current()
    if (route.type !== "session") {
      dialog.clear()
      props.context.ui.toast.show({ message: "Open a session first", variant: "warning" })
      return
    }
    dialog.clear()
    try {
      await props.context.client.session.prompt({
        sessionID: route.sessionID,
        text: entry.text,
        delivery: "queue",
      })
      props.context.ui.toast.show({ message: "Previous prompt queued", variant: "success" })
    } catch (error) {
      props.context.ui.toast.show({
        message: error instanceof Error ? error.message : String(error),
        variant: "error",
      })
    }
  }

  props.context.keymap.layer(() => ({
    mode: "modal",
    target: inputTarget,
    priority: 20,
    commands: [
      {
        bind: "up",
        title: "Previous prompt",
        run: () => setSelected((value) => Math.max(0, value - 1)),
      },
      {
        bind: "down",
        title: "Next prompt",
        run: () => setSelected((value) => Math.min(Math.max(0, results().length - 1), value + 1)),
      },
      {
        bind: "return",
        title: "Use prompt",
        run: () => void select(results()[selected()]),
      },
      {
        bind: "escape",
        title: "Close prompt search",
        run: () => dialog.clear(),
      },
    ],
  }))

  onMount(() => {
    dialog.set({ size: "large", centered: true })
    setTimeout(() => inputTarget()?.focus(), 1)
    void props.indexer.refresh()
  })

  return (
    <box paddingLeft={2} paddingRight={2} gap={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text attributes={TextAttributes.BOLD} fg={theme.text.base}>
          Search previous prompts
        </text>
        <text fg={theme.text.muted}>esc close · enter use</text>
      </box>
      <input
        ref={(value: InputRenderable) => setInputTarget(value)}
        onInput={setQuery}
        onSubmit={() => void select(results()[selected()])}
        placeholder="Type to filter prompts..."
        placeholderColor={theme.text.muted}
        textColor={theme.text.formfield.base}
        focusedTextColor={theme.text.formfield.base}
        cursorColor={theme.text.formfield.base}
      />
      <scrollbox maxHeight={18} scrollbarOptions={{ visible: false }}>
        <Show when={results().length > 0} fallback={<text fg={theme.text.muted}>No matching prompts</text>}>
          <For each={results().slice(0, 50)}>
            {(entry, index) => (
              <box
                paddingLeft={1}
                paddingRight={1}
                backgroundColor={index() === selected() ? theme.background.raised.high : undefined}
              >
                <text fg={index() === selected() ? theme.text.base : theme.text.muted} wrapMode="word">
                  {`${index() + 1}. ${entry.text.replaceAll("\n", " ")}`}
                </text>
                <text fg={theme.text.muted} wrapMode="none">
                  {`${entry.title ?? entry.sessionID} · ${entry.directory ?? "unknown cwd"}`}
                </text>
              </box>
            )}
          </For>
        </Show>
      </scrollbox>
    </box>
  )
}
