import type { Context } from "@opencode/plugin/tui/context"
import { untrack } from "solid-js"

export function registerKeymap(context: Pick<Context, "keymap">, factory: Parameters<Context["keymap"]["layer"]>[0]) {
  // Older hosts evaluate enabled/target while registering; keep those reads out of the slot owner.
  untrack(() => context.keymap.layer(factory))
}
