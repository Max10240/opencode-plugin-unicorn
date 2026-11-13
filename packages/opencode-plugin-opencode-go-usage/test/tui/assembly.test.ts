import { expect, test } from "bun:test"
import type { Context } from "@opencode/plugin/tui/context"
import { COMMAND_ID, SLASH_NAME, setupOpencodeGoUsageTui } from "../../src/tui.js"
import type { AccountRef, AccountUsage } from "../../src/usage.js"

const account: AccountUsage = {
  id: "cred_work",
  label: "Work",
  active: true,
  state: "ok",
  workspace: { id: "org_work", name: "Work" },
  usage: {
    rolling: { percent: 42, limited: false, resetsAt: Date.now() + 1_000 },
    weekly: { percent: 18, limited: false, resetsAt: Date.now() + 2_000 },
    monthly: { percent: 7, limited: false, resetsAt: Date.now() + 3_000 },
  },
}

function setup(
  options: Record<string, unknown>,
  accounts: AccountRef[] = [account],
  usages: AccountUsage[] = [account],
  integrations?: Array<{ id: string; connections: Array<{ type: "credential"; id: string; label: string }> }>,
) {
  let layer: any
  let accountChecks = 0
  const events: string[] = []
  const context = {
    options,
    keymap: { layer: (factory: () => any) => { layer = factory() } },
    client: {
      rpc: () => ({
        accounts: async () => {
          accountChecks++
          return { accounts }
        },
        list: async () => ({ accounts: usages }),
      }),
    },
    data: {
      on: (type: string) => {
        events.push(type)
        return () => {}
      },
      ...(integrations
        ? {
            location: {
              integration: {
                sync: async () => {},
                list: () => integrations,
              },
            },
          }
        : {}),
    },
    ui: { dialog: { show: () => {} } },
  } as unknown as Context
  return { context, layer: () => layer, accountChecks: () => accountChecks, events }
}

test("registers the slash command in the global keymap", () => {
  const harness = setup({ enabled: true })
  setupOpencodeGoUsageTui(harness.context)
  expect(harness.layer()).toMatchObject({
    mode: "global",
    commands: [{
      id: COMMAND_ID,
      title: "OpenCode Go usage",
      palette: true,
      bind: false,
      slash: { name: SLASH_NAME, aliases: ["go-usage"] },
    }],
  })
})

test("auto mode hides the command without credentials and shows it after they appear", async () => {
  const empty = setup({}, [])
  setupOpencodeGoUsageTui(empty.context)
  await Bun.sleep(20)
  expect(empty.layer().commands[0].enabled()).toBe(false)

  const ready = setup({}, [account])
  setupOpencodeGoUsageTui(ready.context)
  await Bun.sleep(20)
  expect(ready.layer().commands[0].enabled()).toBe(true)
})

test("auto mode uses the TUI integration cache before the RPC", async () => {
  const harness = setup({}, [], [], [
    { id: "opencode", connections: [{ type: "credential", id: "cred_work", label: "Work" }] },
  ])
  setupOpencodeGoUsageTui(harness.context)
  await Bun.sleep(20)
  expect(harness.layer().commands[0].enabled()).toBe(true)
  expect(harness.accountChecks()).toBe(0)
})

test("explicit enable skips the availability query, and explicit disable registers nothing", async () => {
  const enabled = setup({ enabled: true }, [])
  setupOpencodeGoUsageTui(enabled.context)
  expect(enabled.layer().commands[0].enabled()).toBe(true)
  expect(enabled.accountChecks()).toBe(0)

  const disabled = setup({ enabled: false })
  expect(setupOpencodeGoUsageTui(disabled.context)).toBeFunction()
  expect(disabled.layer()).toBeUndefined()
})

test("subscribes to credential changes and supports a configured keybind", () => {
  const harness = setup({ enabled: true, keybind: "ctrl+shift+g" })
  setupOpencodeGoUsageTui(harness.context)
  expect(harness.layer().commands[0].bind).toBe("ctrl+shift+g")
  expect(harness.events).toEqual(["credential.updated", "credential.switched", "integration.updated"])
})
