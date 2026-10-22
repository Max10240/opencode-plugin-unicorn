import { Plugin } from "@opencode/plugin/tui"
import type { Context } from "@opencode/plugin/tui/context"
import { Portal, useTerminalDimensions } from "@opentui/solid"
import type { Renderable } from "@opentui/core"
import { createEffect, createMemo, createResource, createSignal, For, onCleanup, Show, untrack } from "solid-js"
import { ImagePreview, showImgEnabled } from "./preview-rpc.js"
import type { PreviewImage } from "./preview-rpc.js"
import { nearViewport, previewAnchors, previewEntries, type PreviewEntry } from "./inline.js"

export default Plugin.define({
  id: "max10240.show-img.tui",
  setup(context) {
    if (showImgEnabled(context.options)) return setupImagePreview(context)
  },
})

export function setupImagePreview(context: Context) {
  if (!showImgEnabled(context.options)) return () => {}
  return context.ui.slot({
    append: "app",
    render: () => <InlineImagePreviews context={context} />,
  })
}

function InlineImagePreviews(props: { context: Context }) {
  type Mount = { entry: PreviewEntry; target: Renderable; active: () => boolean; setActive: (value: boolean) => void; destroyed: () => void }
  let previous = new Map<string, PreviewEntry>()
  const entries = createMemo(() => {
    const route = props.context.ui.router.current()
    const values = route.type !== "session" ? [] : previewEntries(route.sessionID,
      props.context.data.session.message.list(route.sessionID), props.context.data.session.get(route.sessionID)?.revert?.messageID)
    const next = new Map<string, PreviewEntry>()
    for (const entry of values) {
      const old = previous.get(entry.key)
      next.set(entry.key, old && old.assetID === entry.assetID && old.name === entry.name && old.anchors.join() === entry.anchors.join() ? old : entry)
    }
    previous = next
    return [...next.values()]
  })
  const [mounts, setMounts] = createSignal<Mount[]>([])
  let timer: ReturnType<typeof setTimeout> | undefined
  let last = 0
  let fast = 2
  const sync = () => {
    if (timer) clearTimeout(timer)
    timer = undefined
    last = Date.now()
    if (fast > 0) fast--
    const wanted = entries()
    const anchors = previewAnchors(props.context.renderer.root, wanted)
    const old = new Map(mounts().map((mount) => [mount.entry.key, mount]))
    const next: Mount[] = []
    for (const entry of wanted) {
      const target = entry.anchors.map((id) => anchors.get(id)).find(Boolean)
      if (!target) continue
      const current = old.get(entry.key)
      if (current?.target === target && current.entry === entry) { current.setActive(nearViewport(target)); next.push(current); old.delete(entry.key); continue }
      const [active, setActive] = createSignal(nearViewport(target))
      const mount: Mount = { entry, target, active, setActive, destroyed: () => {
        target.off("destroyed", mount.destroyed)
        setMounts((values) => values.filter((value) => value !== mount))
      } }
      target.once("destroyed", mount.destroyed)
      next.push(mount)
    }
    for (const mount of old.values()) mount.target.off("destroyed", mount.destroyed)
    if (next.length !== mounts().length || next.some((mount, index) => mount !== mounts()[index])) setMounts(next)
  }
  const frame = () => {
    if (!timer && untrack(entries).length) timer = setTimeout(() => untrack(sync), fast > 0 ? 0 : Math.max(0, 100 - (Date.now() - last)))
  }
  createEffect(() => { entries(); fast = 2; untrack(sync) })
  props.context.renderer.on("frame", frame)
  onCleanup(() => {
    props.context.renderer.off("frame", frame)
    if (timer) clearTimeout(timer)
    for (const mount of mounts()) mount.target.off("destroyed", mount.destroyed)
  })
  return <For each={mounts()}>{(mount) => {
    let container: Renderable | undefined
    onCleanup(() => {
      container?.off("destroyed", mount.destroyed)
      // Portal detaches its container; release the native subtree after Solid's cleanup.
      void Promise.resolve().then(() => { if (container && !container.isDestroyed) container.destroyRecursively() })
    })
    return <Portal mount={mount.target} ref={(value) => {
      container = value as Renderable
      container.once("destroyed", mount.destroyed)
    }}>
    <box id={`show-img-preview:${mount.entry.key}`} height={10} paddingLeft={3} paddingRight={1} flexShrink={0}>
      <Show when={mount.active()} fallback={<text fg={props.context.theme.text.muted} wrapMode="none" truncate>Image preview: {mount.entry.name} · scroll to load</text>}>
        <ImagePreviewPart context={props.context} entry={mount.entry} />
      </Show>
    </box>
  </Portal> }}</For>
}

function ImagePreviewPart(props: { context: Context; entry: PreviewEntry }) {
  const rpc = props.context.client.rpc(ImagePreview)
  let dialogOwner: object | undefined
  const [image] = createResource(
    () => {
      const controller = new AbortController()
      onCleanup(() => controller.abort())
      return { assetID: props.entry.assetID, sessionID: props.entry.sessionID, signal: controller.signal }
    },
    async (value) => await rpc.read(
      { assetID: value.assetID, sessionID: value.sessionID },
      { location: props.context.data.session.get(value.sessionID)?.location, signal: value.signal },
    ) as PreviewImage,
  )
  const open = () => {
    const value = image()
    if (!value) return
    const owner = {}
    dialogOwner = owner
    props.context.ui.dialog.show(() => <Preview context={props.context} image={value} enlarged />, () => {
      if (dialogOwner === owner) dialogOwner = undefined
    })
  }
  onCleanup(() => { if (dialogOwner) props.context.ui.dialog.clear() })
  return (
      <box gap={1} flexShrink={0}>
        <text fg={props.context.theme.text.muted} wrapMode="none" truncate>Image preview: {props.entry.name}</text>
        <Show when={!image.error} fallback={<text fg={props.context.theme.text.feedback.error.base}>Image preview unavailable</text>}>
          <Show when={!image.loading} fallback={<text fg={props.context.theme.text.muted}>Loading image preview…</text>}>
            <Show when={image()} keyed>
              {(value) => <Preview context={props.context} image={value} onOpen={open} />}
            </Show>
          </Show>
        </Show>
      </box>
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
          <text fg={props.context.theme.text.muted} wrapMode="none" truncate onMouseUp={() => props.onOpen?.()}>
            {size()} · {props.enlarged ? "Esc to close" : "Click to enlarge"}
          </text>
        </Show>
      </Show>
    </box>
  )
}
