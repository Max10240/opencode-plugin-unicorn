import type { Renderable, ScrollBoxRenderable } from "@opentui/core"
import { previewReference, type PreviewReference } from "./preview-rpc.js"

export type PreviewEntry = PreviewReference & { key: string; sessionID: string; anchors: string[] }
type Message = { id: string; type: string; content?: readonly { type: string; id?: string; name?: string; text?: string; state?: unknown }[] }

export function previewEntries(sessionID: string, messages: readonly Message[], revertID?: string): PreviewEntry[] {
  return messages.flatMap((message) => {
    if (message.type !== "assistant" || (revertID && message.id >= revertID)) return []
    let first = true
    return (message.content ?? []).flatMap((part): PreviewEntry[] => {
      if (part.type !== "tool") {
        if (part.text?.trim()) first = false
        return []
      }
      const boundary = first
      first = false
      const state = part.state as { status?: unknown; metadata?: unknown } | undefined
      if (!part.id || !["show_img", "image_gen"].includes(part.name ?? "") || state?.status !== "completed") return []
      const reference = previewReference(state.metadata)
      if (!reference) return []
      return [{ ...reference, key: `${sessionID}:${message.id}:${part.id}`, sessionID,
        anchors: [`session-part:${message.id}:${part.id}`, ...(boundary ? [message.id] : [])] }]
    })
  })
}

export function previewAnchors(root: Renderable, entries: readonly PreviewEntry[]) {
  const wanted = new Set(entries.flatMap((entry) => entry.anchors))
  const found = new Map<string, Renderable>()
  if (!wanted.size) return found
  const visit = (node: Renderable, transcript = false) => {
    if (node.isDestroyed || !node.visible || node.id?.startsWith("show-img-preview:")) return
    if ("scrollTo" in node && "viewport" in node) {
      const viewport = (node as ScrollBoxRenderable).viewport
      if (viewport.width <= 0 || viewport.height <= 0) return
      transcript = true
    }
    if (transcript && wanted.has(node.id) && node.height > 0) found.set(node.id, node)
    for (const child of node.getChildren()) visit(child, transcript)
  }
  visit(root)
  return found
}

export function nearViewport(target: Renderable) {
  for (let node = target.parent; node; node = node.parent) {
    if (!("scrollTo" in node && "viewport" in node)) continue
    const viewport = (node as ScrollBoxRenderable).viewport
    return viewport.height > 0 && target.y + target.height >= viewport.y - viewport.height && target.y <= viewport.y + 2 * viewport.height
  }
  return false
}
