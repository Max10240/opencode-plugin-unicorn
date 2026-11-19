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

type PreviewGroup = {
  key: string
  entries: PreviewEntry[]
  signature: string
}

type Mount = PreviewGroup & {
  target: Renderable
  active: () => boolean
  setActive: (value: boolean) => void
  destroyed: () => void
}

function InlineImagePreviews(props: { context: Context }) {
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
    const old = new Map(mounts().map((mount) => [mount.key, mount]))
    const next: Mount[] = []
    for (const group of groupEntries(wanted)) {
      const target = group.entries.flatMap((entry) => entry.anchors).map((id) => anchors.get(id)).find(Boolean)
      if (!target) continue
      const current = old.get(group.key)
      if (current?.target === target && current.signature === group.signature) {
        current.setActive(nearViewport(target))
        next.push(current)
        old.delete(group.key)
        continue
      }
      const [active, setActive] = createSignal(nearViewport(target))
      const mount: Mount = {
        ...group,
        target,
        active,
        setActive,
        destroyed: () => {
          target.off("destroyed", mount.destroyed)
          setMounts((values) => values.filter((value) => value !== mount))
        },
      }
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
      <MountedPreview context={props.context} mount={mount} />
    </Portal>
  }}</For>
}

function groupEntries(entries: readonly PreviewEntry[]): PreviewGroup[] {
  const groups = new Map<string, PreviewEntry[]>()
  for (const entry of entries) {
    const key = entry.key.slice(0, Math.max(0, entry.key.lastIndexOf(":")))
    const group = groups.get(key)
    if (group) group.push(entry)
    else groups.set(key, [entry])
  }
  return [...groups].map(([key, values]) => ({
    key,
    entries: values,
    signature: values.map((entry) => `${entry.key}:${entry.assetID}:${entry.name}`).join("|"),
  }))
}

function MountedPreview(props: { context: Context; mount: Mount }) {
  const [target, setTarget] = createSignal<Renderable>()
  let dialogOwner: object | undefined

  const open = () => {
    const owner = {}
    dialogOwner = owner
    props.context.ui.dialog.show(
      () => <Gallery context={props.context} entries={props.mount.entries} />,
      () => {
        if (dialogOwner === owner) dialogOwner = undefined
      },
    )
  }

  props.context.keymap.layer(() => ({
    mode: "base",
    target,
    priority: 10,
    commands: [
      { bind: "return", title: "Enlarge image preview", run: open },
      { bind: "o", title: "Enlarge image preview", run: open },
    ],
  }))

  onCleanup(() => { if (dialogOwner) props.context.ui.dialog.clear() })

  return (
    <box
      id={`show-img-preview:${props.mount.key}`}
      ref={(value: Renderable) => setTarget(value)}
      focusable
      height={10}
      paddingLeft={3}
      paddingRight={1}
      flexShrink={0}
      onMouseUp={(event) => {
        if (event.button !== 0) return
        event.stopPropagation()
        target()?.focus()
        open()
      }}
    >
      <Show when={props.mount.active()} fallback={<text fg={props.context.theme.text.muted} wrapMode="none" truncate>Image preview: {props.mount.entries[0]!.name} · scroll to load</text>}>
        <InlinePreview context={props.context} mount={props.mount} onOpen={open} />
      </Show>
    </box>
  )
}

function InlinePreview(props: { context: Context; mount: Mount; onOpen: () => void }) {
  const rpc = props.context.client.rpc(ImagePreview)
  const entry = () => props.mount.entries[0]!
  const [image] = createResource(
    () => {
      const controller = new AbortController()
      onCleanup(() => controller.abort())
      return { assetID: entry().assetID, sessionID: entry().sessionID, signal: controller.signal }
    },
    async (value) => await rpc.read(
      { assetID: value.assetID, sessionID: value.sessionID },
      { location: props.context.data.session.get(value.sessionID)?.location, signal: value.signal },
    ) as PreviewImage,
  )
  return (
    <box gap={1} flexShrink={0}>
      <text fg={props.context.theme.text.muted} wrapMode="none" truncate>
        {`Image preview: ${entry().name}${props.mount.entries.length > 1 ? ` · 1 of ${props.mount.entries.length}` : ""}`}
      </text>
      <Show when={!image.error} fallback={<text fg={props.context.theme.text.feedback?.error?.base ?? props.context.theme.text.base}>Image preview unavailable · Enter/o retry</text>}>
        <Show when={!image.loading} fallback={<text fg={props.context.theme.text.muted}>Loading image preview…</text>}>
          <Show when={image()} keyed>
            {(value) => <Preview context={props.context} image={value} onOpen={props.onOpen} hint={props.mount.entries.length > 1 ? `Enter/o open ${props.mount.entries.length} images` : "Enter/o enlarge"} />}
          </Show>
        </Show>
      </Show>
    </box>
  )
}

function Gallery(props: { context: Context; entries: readonly PreviewEntry[] }) {
  props.context.ui.dialog.set({ size: "xlarge", centered: true })
  const [index, setIndex] = createSignal(0)
  const rpc = props.context.client.rpc(ImagePreview)
  const entry = () => props.entries[index()]!
  const [image] = createResource(
    () => {
      const current = entry()
      const controller = new AbortController()
      onCleanup(() => controller.abort())
      return { index: index(), assetID: current.assetID, sessionID: current.sessionID, signal: controller.signal }
    },
    async (value) => await rpc.read(
      { assetID: value.assetID, sessionID: value.sessionID },
      { location: props.context.data.session.get(value.sessionID)?.location, signal: value.signal },
    ) as PreviewImage,
  )
  const move = (delta: number) => {
    const count = props.entries.length
    setIndex((value) => (value + delta + count) % count)
  }
  props.context.keymap.layer(() => ({
    mode: "modal",
    priority: 20,
    commands: [
      { bind: "left", title: "Previous image", run: () => move(-1) },
      { bind: "right", title: "Next image", run: () => move(1) },
      { bind: "up", title: "Previous image", run: () => move(-1) },
      { bind: "down", title: "Next image", run: () => move(1) },
      { bind: "escape", title: "Close image gallery", run: () => props.context.ui.dialog.clear() },
    ],
  }))
  return (
    <box paddingLeft={2} paddingRight={2} gap={1}>
      <text fg={props.context.theme.text.base}>
        {`${entry().name} · ${index() + 1}/${props.entries.length}`}
      </text>
      <Show when={image.error} fallback={
        <Show when={!image.loading} fallback={<text fg={props.context.theme.text.muted}>Loading image…</text>}>
          <Show when={image()} keyed>
            {(value) => <Preview context={props.context} image={value} enlarged />}
          </Show>
        </Show>
      }>
        <text fg={props.context.theme.text.feedback?.error?.base ?? props.context.theme.text.base}>Could not load this image.</text>
      </Show>
      <text fg={props.context.theme.text.muted}>
        {props.entries.length > 1 ? "←/→ browse · Esc to close" : "Esc to close"}
      </text>
    </box>
  )
}

function Preview(props: { context: Context; image: PreviewImage; enlarged?: boolean; onOpen?: () => void; hint?: string }) {
  const dimensions = useTerminalDimensions()
  const [failed, setFailed] = createSignal(false)
  const [size, setSize] = createSignal<string>()
  const bytes = Buffer.from(props.image.data, "base64")
  return (
    <box gap={1} flexShrink={0}>
      <Show when={!failed()} fallback={<text fg={props.context.theme.text.feedback?.error?.base ?? props.context.theme.text.base}>Could not decode image</text>}>
        <box height={props.enlarged ? Math.max(3, dimensions().height - 10) : 6} onMouseUp={(event) => {
          if (event.button !== 0) return
          event.stopPropagation()
          props.onOpen?.()
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
        <text fg={props.context.theme.text.muted} wrapMode="none" truncate>
          {`${formatBytes(bytes.length)}${size() ? ` · ${size()}` : ""} · ${props.enlarged ? "Esc to close" : props.hint ?? "Enter/o enlarge"}`}
        </text>
      </Show>
    </box>
  )
}

function formatBytes(value: number) {
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${Math.round(value / 1024)} KB`
  return `${(value / (1024 * 1024)).toFixed(1)} MB`
}
