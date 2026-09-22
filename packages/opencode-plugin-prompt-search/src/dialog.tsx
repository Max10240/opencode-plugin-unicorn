import { TextAttributes, type EditBufferRenderable, type InputRenderable, type ScrollBoxRenderable } from "@opentui/core"
import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js"
import type { Context } from "@opencode/plugin/tui/context"
import { PromptIndexer, type PromptEntry } from "./indexer.js"

export function PromptSearchDialog(props: {
  context: Context
  indexer: PromptIndexer
  composer?: EditBufferRenderable | null
}) {
  const dialog = props.context.ui.dialog
  const theme = props.context.theme.surface("dialog")
  const [query, setQuery] = createSignal("")
  const [selected, setSelected] = createSignal(0)
  const [inputTarget, setInputTarget] = createSignal<InputRenderable>()
  const [resultsTarget, setResultsTarget] = createSignal<ScrollBoxRenderable>()
  const results = createMemo(() => props.indexer.search(query()))
  let scrollTimer: ReturnType<typeof setTimeout> | undefined

  createEffect(() => {
    results()
    setSelected(0)
  })

  createEffect(() => {
    const entries = results()
    const index = selected()
    if (!entries[index] || !resultsTarget()) return
    if (scrollTimer !== undefined) clearTimeout(scrollTimer)
    scrollTimer = setTimeout(() => {
      scrollTimer = undefined
      const scrollbox = resultsTarget()
      if (!scrollbox || scrollbox.isDestroyed) return
      scrollbox.scrollChildIntoView(resultID(index))
    }, 0)
  })

  onCleanup(() => {
    if (scrollTimer !== undefined) clearTimeout(scrollTimer)
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
      const composer = props.composer ?? props.context.renderer.currentFocusedEditor
      if (!composer) throw new Error("Could not find the current prompt input")
      composer.insertText(entry.text)
      composer.focus()
      props.context.ui.toast.show({ message: "Previous prompt inserted", variant: "success" })
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
      <scrollbox ref={(value: ScrollBoxRenderable) => setResultsTarget(value)} maxHeight={18} scrollbarOptions={{ visible: false }}>
        <Show when={results().length > 0} fallback={<text fg={theme.text.muted}>No matching prompts</text>}>
          <For each={results().slice(0, 50)}>
            {(entry, index) => (
              <box
                id={resultID(index())}
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

function resultID(index: number) {
  return `prompt-search-result-${index}`
}
