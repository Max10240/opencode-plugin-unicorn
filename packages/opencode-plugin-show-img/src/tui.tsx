import { Plugin } from "@opencode/plugin/tui"
import type { Context } from "@opencode/plugin/tui/context"
import { useTerminalDimensions } from "@opentui/solid"
import { createMemo, createResource, createSignal, onCleanup, Show } from "solid-js"
import { ImagePreview, previewReference, showImgEnabled } from "./preview-rpc.js"
import type { PreviewImage } from "./preview-rpc.js"

export default Plugin.define({
  id: "max10240.show-img.tui",
  setup(context) {
    if (showImgEnabled(context.options)) return setupImagePreview(context)
  },
})

export function setupImagePreview(context: Context) {
  if (!showImgEnabled(context.options)) return () => {}
  return context.ui.slot({
    append: "session.composer.top",
    render: (input) => <ImagePreviewSlot context={context} sessionID={input.sessionID} />,
  })
}

function ImagePreviewSlot(props: { context: Context; sessionID: string }) {
  const rpc = props.context.client.rpc(ImagePreview)
  const reference = createMemo(() => {
    const messages = props.context.data.session.message.list(props.sessionID)
    for (const message of messages.toReversed()) {
      if (message.type !== "assistant") continue
      for (const part of message.content.toReversed()) {
        if (part.type !== "tool" || !["show_img", "image_gen"].includes(part.name) || part.state.status !== "completed") continue
        const value = previewReference(part.state.metadata)
        if (value) return value
      }
    }
  }, undefined, { equals: (previous, next) => previous?.assetID === next?.assetID })
  const [image] = createResource(
    () => {
      const value = reference()
      if (!value) return
      const controller = new AbortController()
      onCleanup(() => controller.abort())
      return { assetID: value.assetID, sessionID: props.sessionID, signal: controller.signal }
    },
    async (value) => await rpc.read(
      { assetID: value.assetID, sessionID: value.sessionID },
      { location: props.context.data.session.get(value.sessionID)?.location, signal: value.signal },
    ) as PreviewImage,
  )
  const open = () => {
    const value = image()
    if (!value) return
    props.context.ui.dialog.show(() => <Preview context={props.context} image={value} enlarged />)
  }
  return (
    <Show when={reference()}>
      <box paddingLeft={2} paddingRight={2} gap={1} flexShrink={0}>
        <text fg={props.context.theme.text.muted}>Image preview: {reference()?.name}</text>
        <Show when={!image.error} fallback={<text fg={props.context.theme.text.feedback.error.base}>Image preview unavailable</text>}>
          <Show when={!image.loading} fallback={<text fg={props.context.theme.text.muted}>Loading image preview…</text>}>
            <Show when={image()} keyed>
              {(value) => <Preview context={props.context} image={value} onOpen={open} />}
            </Show>
          </Show>
        </Show>
      </box>
    </Show>
  )
}

function Preview(props: { context: Context; image: PreviewImage; enlarged?: boolean; onOpen?: () => void }) {
  if (props.enlarged) props.context.ui.dialog.set({ size: "xlarge", centered: true })
  const dimensions = useTerminalDimensions()
  const [failed, setFailed] = createSignal(false)
  const [size, setSize] = createSignal<string>()
  const bytes = Buffer.from(props.image.data, "base64")
  return (
    <box gap={1} flexShrink={0}>
      <Show when={props.enlarged}>
        <text fg={props.context.theme.text.base}>{props.image.name}</text>
      </Show>
      <Show when={!failed()} fallback={<text fg={props.context.theme.text.feedback.error.base}>Could not decode image</text>}>
        <box height={props.enlarged ? Math.max(3, dimensions().height - 10) : 6} onMouseUp={(event) => {
          if (event.button === 0) props.onOpen?.()
        }}>
          <image
            source={bytes}
            fit="fit"
            protocol="auto"
            width="100%"
            height="100%"
            onLoad={(loaded) => setSize(`${loaded.width} x ${loaded.height}`)}
            onError={() => setFailed(true)}
          />
        </box>
        <Show when={size()}>
          <text fg={props.context.theme.text.muted} onMouseUp={() => props.onOpen?.()}>
            {size()} · {props.enlarged ? "Esc to close" : "Click to enlarge"}
          </text>
        </Show>
      </Show>
    </box>
  )
}
