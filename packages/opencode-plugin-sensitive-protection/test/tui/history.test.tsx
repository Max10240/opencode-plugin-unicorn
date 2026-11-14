/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import type { Context } from "@opencode/plugin/tui/context"
import { testRender } from "@opentui/solid"
import { createSignal } from "solid-js"
import type { ProtectionHit } from "../../src/rpc.js"
import {
  ProtectionHistoryDialog,
  RecentProtectionChip,
  type ProtectionHistoryStore,
} from "../../src/tui-history.js"

const theme = {
  text: {
    base: "#ffffff",
    muted: "#aaaaaa",
    feedback: {
      error: { base: "#ff0000" },
      warning: { base: "#ffff00" },
      success: { base: "#00ff00" },
      info: { base: "#00ffff" },
    },
    action: { primary: { base: "#00aaff" } },
  },
  background: { raised: { high: "#333333" } },
  formfield: { base: "#ffffff" },
  surface: () => theme,
}

const now = Date.now()

function hit(input: Partial<ProtectionHit> & Pick<ProtectionHit, "id" | "kind" | "source" | "count">): ProtectionHit {
  return {
    time: now,
    firstTime: now,
    occurrences: 1,
    ...input,
  }
}

function createHarness(initial: ProtectionHit[]) {
  const [hits, setHits] = createSignal(initial)
  const layers: any[] = []
  const notices: any[] = []
  let copied = ""
  const store: ProtectionHistoryStore = {
    hits: () => hits(),
    recent: () => undefined,
    load: async () => ({ limit: 200 }),
    clear: async () => 0,
    dismissRecent: () => {},
    dispose: () => {},
  }
  const context = {
    options: {},
    theme,
    keymap: {
      layer: (factory: () => any) => { layers.push(factory()) },
      shortcuts: () => ["ctrl+shift+h"],
    },
    data: {
      session: {
        get: (id: string) => ({
          title: id === "ses_one" ? "Fix auth flow" : "Other session",
          location: { directory: id === "ses_one" ? "/Users/max/project" : "/Users/max/other" },
        }),
      },
    },
    client: { session: { get: async () => undefined } },
    renderer: { copyToClipboardOSC52: (value: string) => { copied = value; return true } },
    ui: {
      dialog: { set() {}, clear() {} },
      toast: { show: (value: any) => notices.push(value) },
      format: { path: (value: string) => value.replace("/Users/max", "~") },
      router: { navigate: () => {} },
    },
  } as unknown as Context
  return { context, store, layers, notices, setHits, copied: () => copied }
}

async function render(harness: ReturnType<typeof createHarness>) {
  return testRender(
    () => (
      <box width="100%" height="100%">
        <ProtectionHistoryDialog context={harness.context} store={harness.store} sessionID="ses_one" />
      </box>
    ),
    { width: 120, height: 50 },
  )
}

async function waitFor(app: { flush(): Promise<void>; captureCharFrame(): string }, check: () => boolean, message: string) {
  const deadline = Date.now() + 2_000
  while (Date.now() < deadline) {
    await app.flush()
    if (check()) return
    await Bun.sleep(5)
  }
  throw new Error(`${message}\n${app.captureCharFrame()}`)
}

test("clicking the footer chip opens protection history", async () => {
  let dialog: (() => unknown) | undefined
  let dismissed = false
  const store: ProtectionHistoryStore = {
    hits: () => [],
    recent: () => ({
      id: "hit-1",
      kind: "blocked",
      count: 1,
      sessionID: "ses_one",
      time: Date.now(),
    }),
    load: async () => ({ limit: 200 }),
    clear: async () => 0,
    dismissRecent: () => { dismissed = true },
    dispose: () => {},
  }
  const context = {
    options: {},
    theme,
    renderer: { copyToClipboardOSC52: () => true },
    keymap: { layer() {}, shortcuts: () => [] },
    data: { session: { get: () => ({ title: "Fix auth flow", location: { directory: "/Users/max/project" } }) } },
    client: { session: { get: async () => undefined } },
    ui: {
      dialog: {
        show(render: () => unknown) { dialog = render },
        set() {},
        clear() {},
      },
      toast: { show() {} },
      format: { path: (value: string) => value.replace("/Users/max", "~") },
      router: { navigate() {} },
    },
  } as unknown as Context
  const app = await testRender(
    () => (
      <box width="100%" height="100%">
        <RecentProtectionChip context={context} store={store} sessionID="ses_one" />
      </box>
    ),
    { width: 80, height: 4 },
  )
  try {
    await waitFor(app, () => app.captureCharFrame().includes("access blocked · details"), "chip did not render")
    const chip = app.renderer.root.findDescendantById("sensitive-protection-recent-chip")!
    await app.mockMouse.click(chip.x, chip.y)
    await waitFor(app, () => dialog !== undefined, "chip click did not open history")
    expect(dismissed).toBe(true)
  } finally {
    app.renderer.destroy()
  }
})

test("renders attribution, session metadata, and live updates without secret values", async () => {
  const harness = createHarness([
    hit({
      id: "hit-1",
      kind: "blocked",
      source: "read",
      count: 1,
      file: "/Users/max/.ssh/id_ed25519",
      label: "SSH private key",
      tool: "read",
      sessionID: "ses_one",
      matches: [{ file: "/Users/max/.ssh/id_ed25519", label: "SSH private key", source: "builtin", count: 1 }],
    }),
    hit({
      id: "hit-2",
      kind: "redacted",
      source: "context",
      count: 8,
      sessionID: "ses_one",
      matches: [{ file: "/Users/max/.aws/credentials", label: "AWS credentials", source: "builtin", key: "default.aws_secret_access_key", count: 8 }],
    }),
  ])
  const app = await render(harness)
  try {
    await waitFor(app, () => app.captureCharFrame().includes("Blocked read"), "history did not render")
    const frame = app.captureCharFrame()
    expect(frame).toContain("Sensitive protection")
    expect(frame).toContain("This session")
    expect(frame).toContain("Model context")
    expect(frame).toContain("8 values")
    expect(frame).toContain("default.aws_secret_access_key in AWS credentials")
    expect(frame).toContain("Fix auth flow")
    expect(frame).toContain("~/project")
    expect(frame).not.toContain("NOTIFY_SECRET_VALUE")

    harness.setHits([
      ...harness.store.hits(),
      hit({
        id: "hit-3",
        kind: "error",
        source: "parser",
        count: 0,
        file: "/Users/max/.npmrc",
        label: "npm auth",
        sessionID: "ses_two",
        matches: [{ file: "/Users/max/.npmrc", label: "npm auth", source: "builtin", count: 0 }],
      }),
    ])
    const toggleScope = harness.layers
      .flatMap((layer) => layer.commands)
      .find((command) => command.title === "Toggle protection session scope")
    toggleScope?.run()
    await waitFor(app, () => app.captureCharFrame().includes("All sessions"), "scope did not switch")
    await waitFor(app, () => app.captureCharFrame().includes("Protection error"), "live event did not render")
    expect(app.captureCharFrame()).toContain("Other session")

    const copy = harness.layers
      .flatMap((layer) => layer.commands)
      .find((command) => command.title === "Copy protection event")
    copy?.run()
    expect(harness.copied()).toContain("Sensitive protection event")
    expect(harness.copied()).not.toContain("NOTIFY_SECRET_VALUE")
    expect(harness.notices.at(-1)).toMatchObject({ variant: "success" })
  } finally {
    app.renderer.destroy()
  }
})

test("detail and copy include the matched file path and key", async () => {
  const harness = createHarness([
    hit({
      id: "hit-npmrc",
      kind: "redacted",
      source: "tool",
      count: 2,
      tool: "shell",
      sessionID: "ses_one",
      matches: [{
        file: "/Users/max/.npmrc",
        label: "npm auth",
        source: "builtin",
        key: "_authToken @ registry.npmjs.org",
        count: 2,
      }],
    }),
  ])
  const app = await render(harness)
  try {
    await waitFor(app, () => app.captureCharFrame().includes("~/.npmrc"), "matched file did not render")
    const frame = app.captureCharFrame()
    expect(frame).toContain("_authToken @ registry.npmjs.org")
    expect(frame).toContain("File: ~/.npmrc")

    const copy = harness.layers
      .flatMap((layer) => layer.commands)
      .find((command) => command.title === "Copy protection event")
    copy?.run()
    expect(harness.copied()).toContain("_authToken @ registry.npmjs.org")
    expect(harness.copied()).toContain("File: /Users/max/.npmrc")
  } finally {
    app.renderer.destroy()
  }
})
