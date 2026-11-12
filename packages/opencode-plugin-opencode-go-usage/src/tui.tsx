import { Plugin } from "@opencode/plugin/tui"
import type { Context } from "@opencode/plugin/tui/context"
import { TextAttributes, type ScrollBoxRenderable } from "@opentui/core"
import { For, Show, createSignal, onCleanup, onMount } from "solid-js"
import { formatPercent, formatReset, meterBar } from "./format.js"
import { resolveEnabled, resolveKeybind, usageEnabled } from "./options.js"
import { OpencodeGoUsageRpc } from "./rpc.js"
import type { AccountRef, AccountUsage, Meter } from "./usage.js"

export const COMMAND_ID = "max10240.opencode-go-usage.open"
export const SLASH_NAME = "usage-opencode-go"
export const SLASH_ALIAS = "go-usage"

export default Plugin.define({
  id: "max10240.opencode-go-usage.tui",
  setup: setupOpencodeGoUsageTui,
})

export function setupOpencodeGoUsageTui(context: Context) {
  if (!usageEnabled(context.options) || !context.keymap || !context.client?.rpc) return () => {}

  const mode = resolveEnabled(context.options.enabled)
  const keybind = resolveKeybind(context.options.keybind)
  const [available, setAvailable] = createSignal(mode === true)
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | undefined

  const checkRPC = async () => {
    const result = (await context.client.rpc(OpencodeGoUsageRpc).accounts({})) as { accounts: AccountRef[] }
    if (!stopped) setAvailable(result.accounts.length > 0)
  }
  const check = async () => {
    if (mode === true) return
    const integrations = context.data?.location?.integration
    if (integrations) {
      try {
        await integrations.sync(context.location)
        const cached = integrations.list(context.location)
        if (!cached) {
          await checkRPC()
          return
        }
        const integration = cached.find((item) => item.id === "opencode")
        const accounts = integration?.connections.filter((connection) => connection.type === "credential") ?? []
        if (!stopped) setAvailable(accounts.length > 0)
        return
      } catch {
        // Fall back to the server RPC when the client cache cannot be loaded.
      }
    }
    try {
      await checkRPC()
    } catch {
      if (!stopped) setAvailable(false)
    }
  }
  const schedule = () => {
    if (timer !== undefined) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = undefined
      void check()
    }, 100)
  }

  if (mode === "auto") void check()

  const offs: Array<() => void> = []
  if (context.data?.on) {
    offs.push(
      context.data.on("credential.updated", schedule),
      context.data.on("credential.switched", schedule),
      context.data.on("integration.updated", schedule),
    )
  }

  context.keymap.layer(() => ({
    mode: "global",
    priority: 10,
    commands: [
      {
        id: COMMAND_ID,
        title: "OpenCode Go usage",
        description: "Show 5-hour, weekly, and monthly limits for every OpenCode Go account",
        group: "Usage",
        palette: true,
        bind: keybind,
        slash: { name: SLASH_NAME, aliases: [SLASH_ALIAS] },
        enabled: () => available(),
        run: () => openOpencodeGoUsage(context),
      },
    ],
  }))

  return () => {
    stopped = true
    if (timer !== undefined) clearTimeout(timer)
    for (const off of offs) off()
  }
}

export function openOpencodeGoUsage(context: Context) {
  context.ui.dialog.show(() => <OpencodeGoUsageDialog context={context} />)
}

export function OpencodeGoUsageDialog(props: { context: Context }) {
  const theme = props.context.theme.surface("dialog")
  const [accounts, setAccounts] = createSignal<AccountUsage[]>([])
  const [loading, setLoading] = createSignal(true)
  const [error, setError] = createSignal<string>()
  const [updated, setUpdated] = createSignal<number>()
  let scroll: ScrollBoxRenderable | undefined
  let generation = 0
  let focusTimer: ReturnType<typeof setTimeout> | undefined

  const load = async (refresh = false) => {
    const token = ++generation
    setLoading(true)
    setError(undefined)
    const request = () =>
      props.context.client.rpc(OpencodeGoUsageRpc).list({ refresh }) as Promise<{ accounts: AccountUsage[] }>
    try {
      let result: { accounts: AccountUsage[] }
      try {
        result = await request()
      } catch (cause) {
        if (token !== generation) return
        // A cold location can still be activating its server plugins.
        await new Promise((resolve) => setTimeout(resolve, 250))
        if (token !== generation) return
        try {
          result = await request()
        } catch {
          throw cause
        }
      }
      if (token !== generation) return
      setAccounts(result.accounts)
      setUpdated(Date.now())
    } catch (cause) {
      if (token !== generation) return
      setError(cause instanceof Error ? cause.message : "OpenCode Go usage is unavailable.")
    } finally {
      if (token === generation) setLoading(false)
    }
  }

  props.context.keymap.layer(() => ({
    mode: "modal",
    target: () => scroll,
    priority: 20,
    commands: [
      { bind: "escape", title: "Close usage", run: () => props.context.ui.dialog.clear() },
      { bind: "r", title: "Refresh usage", run: () => void load(true) },
    ],
  }))

  onMount(() => {
    props.context.ui.dialog.set({ size: "large", centered: true })
    focusTimer = setTimeout(() => scroll?.focus(), 50)
    void load(true)
  })
  onCleanup(() => {
    generation++
    if (focusTimer !== undefined) clearTimeout(focusTimer)
  })

  return (
    <box paddingLeft={2} paddingRight={2} gap={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text attributes={TextAttributes.BOLD} fg={theme.text.base}>
          OpenCode Go usage
        </text>
        <text fg={theme.text.muted}>{loading() ? "refreshing…" : "r refresh · esc close"}</text>
      </box>
      <Show when={error()}>
        {(value) => (
          <text fg={theme.text.feedback.error.base} wrapMode="word">
            {value()}
          </text>
        )}
      </Show>
      <Show when={loading() && accounts().length === 0}>
        <text fg={theme.text.muted}>Loading…</text>
      </Show>
      <Show when={!loading() && !error() && accounts().length === 0}>
        <text fg={theme.text.muted} wrapMode="word">
          No OpenCode Go accounts found. Add one with /connect.
        </text>
      </Show>
      <scrollbox
        ref={(value) => {
          scroll = value
        }}
        focusable
        maxHeight={20}
      >
        <For each={accounts()}>{(account) => <AccountRow account={account} theme={theme} />}</For>
      </scrollbox>
      <Show when={updated()}>
        {(value) => (
          <text fg={theme.text.muted}>
            Updated {new Date(value()).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}
          </text>
        )}
      </Show>
    </box>
  )
}

function AccountRow(props: { account: AccountUsage; theme: any }) {
  return (
    <box flexDirection="column" gap={1} paddingBottom={1}>
      <text attributes={TextAttributes.BOLD} fg={props.theme.text.base}>
        {`${props.account.active ? "●" : "○"} ${props.account.label}${props.account.active ? " (active)" : ""}`}
      </text>
      <Show when={props.account.workspace}>
        {(value) => <text fg={props.theme.text.muted}>{value().name ?? value().id}</text>}
      </Show>
      <Show
        when={props.account.usage}
        fallback={
          <text fg={props.theme.text.feedback.warning.base} wrapMode="word">
            {description(props.account)}
          </text>
        }
      >
        {(usage) => (
          <>
            <MeterRow label="5 hours" meter={usage().rolling} theme={props.theme} />
            <MeterRow label="Weekly" meter={usage().weekly} theme={props.theme} />
            <MeterRow label="Monthly (total)" meter={usage().monthly} theme={props.theme} />
          </>
        )}
      </Show>
    </box>
  )
}

function MeterRow(props: { label: string; meter: Meter; theme: any }) {
  const percent = () => Math.max(0, Math.min(100, props.meter.percent))
  const color = () =>
    props.meter.limited || percent() >= 90
      ? props.theme.text.feedback.error.base
      : percent() >= 70
        ? props.theme.text.feedback.warning.base
        : props.theme.text.base
  const status = () => (props.meter.limited ? "limit reached" : `${formatPercent(percent())} used`)
  return (
    <box flexDirection="column">
      <text>
        <span style={{ fg: props.theme.text.muted }}>{props.label}</span>
        <span style={{ fg: color() }}>{`  ${meterBar(percent())} ${status()}`}</span>
      </text>
      <text fg={props.theme.text.muted}>resets {formatReset(props.meter.resetsAt)}</text>
    </box>
  )
}

function description(account: AccountUsage) {
  if (account.state === "not_subscribed") return "No OpenCode Go subscription on this workspace."
  if (account.state === "needs_auth") return "Sign in again with /connect."
  if (account.state === "unsupported") return account.error ?? "This account cannot be queried."
  return account.error ?? "OpenCode Go usage is unavailable."
}
