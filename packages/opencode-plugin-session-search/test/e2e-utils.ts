import { expect } from "bun:test"
import { readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import type { OpenCodeE2E } from "../../opencode-plugin-unicorn/test/e2e-utils.js"
import { e2eEnvironment } from "../../opencode-plugin-unicorn/test/e2e-environment.js"
import { api, prompt, waitFor } from "../../opencode-plugin-show-img/test/e2e-utils.js"
import { createTmux } from "../../../test/tmux.js"

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`

export async function checkSessionSearch(e2e: OpenCodeE2E, options: { combined?: boolean; disabled?: boolean; compact?: boolean; long?: boolean } = {}) {
  const plugin = (await e2e.config()).plugins[0].package
  const rootID = crypto.randomUUID().replaceAll("-", "")
  const messageID = (index: number) => `msg_000000000${String(index).padStart(6, "0")}${rootID}`
  const seeded = await api<any>(e2e, "/api/session", { agent: "compaction-e2e", model: { providerID: "openai", id: "gpt-5.6-luna" }, location: { directory: e2e.workspace } })
  await prompt(e2e, seeded.data.id, "SEED_SESSION_SEARCH")
  const original = (await api<any>(e2e, `/api/experimental/session/${seeded.data.id}/export`)).data
  const user = original.messages.find((message: any) => message.type === "user")
  const assistant = original.messages.find((message: any) => message.type === "assistant")
  const idle = original.messages.find((message: any) => message.type === "idle")
  const count = options.long ? 260 : 30
  const target = options.long ? 40 : 5
  const messages: any[] = []
  const start = Date.now() - 100_000
  for (let index = 0; index < count; index++) {
    const mark = String(index).padStart(3, "0")
    messages.push({ ...user, id: messageID(index * 3), time: { created: start + index * 100 }, text: `USER-ANCHOR-${mark} ` + "user transcript line\n".repeat(5) })
    messages.push({ ...assistant, id: messageID(index * 3 + 1), time: { created: start + index * 100 + 1, completed: start + index * 100 + 2 }, content: [
      { type: "text", text: `AGENT-ANCHOR-${mark} ` + "agent transcript line\n".repeat(8) },
      ...(index === target ? [{ type: "text", text: `SECOND-AGENT-PART-${mark} ` + "second part line\n".repeat(8) }] : []),
    ] })
    messages.push({ ...idle, id: messageID(index * 3 + 2), time: { created: start + index * 100 + 3 } })
  }
  const title = `Session-Search-${rootID.slice(0, 8)}`
  const imported = await api<any>(e2e, "/api/experimental/session/import", {
    info: { ...original.info, id: `ses_search_${rootID}`, title }, messages, location: { directory: e2e.workspace },
  })
  const sessionID = imported.data.id
  if (options.compact) {
    await api(e2e, `/api/session/${sessionID}/compact`, {})
    await api(e2e, `/api/experimental/session/${sessionID}/wait`, {})
    const compacted = (await api<any>(e2e, `/api/experimental/session/${sessionID}/export`)).data
    expect(compacted.messages.some((message: any) => message.type === "compaction" && message.status === "completed")).toBe(true)
    expect(compacted.messages.some((message: any) => message.id === messageID(target * 3 + 1))).toBe(true)
  }
  const features = { sessionSearch: !options.disabled, promptSearch: options.combined === true, imageGen: false, showImg: options.combined === true, recommendedOpencodeConfig: false }
  const cliConfig = {
    session: { scrollbar: true }, keybinds: {
      "command.palette.show": "f10", "session.list": "f8", "session.message.user.next": "f6", "session.message.user.previous": "f7", "session.last": "f9",
    },
    plugins: [{ package: plugin, options: options.combined ? { features, keybind: "f12", sessionSearchKeybind: "f11" } : { features, keybind: "f11" } }],
  }
  const cliPath = path.join(e2e.configDirectory, "cli.json")
  await writeFile(cliPath, JSON.stringify(cliConfig))
  const tmux = createTmux()
  const environment = { ...e2eEnvironment({ root: e2e.root, configDirectory: e2e.configDirectory, password: "opencode-plugin-unicorn-e2e" }), TERM: "xterm-256color" }
  const command = [`cd ${quote(e2e.workspace)} && env -i`, ...Object.entries(environment).map(([key, value]) => `${key}=${quote(value!)}`),
    [process.env.OPENCODE_BIN ?? "opencode", "--server", e2e.baseURL, "--session", sessionID].map(quote).join(" ")].join(" ")
  const pane = () => tmux(["capture-pane", "-pt", "search"]).stdout.toString()
  const closeSearch = async () => { tmux(["send-keys", "-t", "search", "Escape"]); await waitFor(async () => !pane().includes("Search current session"), "Search dialog did not close") }
  const search = async (query: string) => {
    tmux(["send-keys", "-t", "search", "F11"])
    await waitFor(async () => pane().includes("Search current session"), "Session search did not open")
    tmux(["send-keys", "-t", "search", "-l", query])
    await waitFor(async () => !pane().includes("Loading history") && /\b1\/1 matches\b/.test(pane()), "Search did not finish all history pages")
  }
  const checkPromptSearch = async () => {
    const before = e2e.proxy.mock.getRequests().length
    tmux(["send-keys", "-t", "search", "F12"])
    await waitFor(async () => pane().includes("Search previous prompts"), "Session search interfered with the prompt-search shortcut")
    tmux(["send-keys", "-t", "search", "-l", "SEED_SESSION_SEARCH"])
    await waitFor(async () => pane().split("SEED_SESSION_SEARCH").length >= 3, "Prompt search did not find its original history")
    tmux(["send-keys", "-t", "search", "Enter"])
    await waitFor(async () => !pane().includes("Search previous prompts") && pane().includes("SEED_SESSION_SEARCH"), "Prompt search did not insert into the composer")
    expect(e2e.proxy.mock.getRequests().length).toBe(before)
  }
  try {
    tmux(["new-session", "-d", "-s", "search", "-x", "115", "-y", "36", command])
    await waitFor(async () => pane().includes(title) && pane().includes("f10 commands"), "Session search TUI did not start")
    tmux(["send-keys", "-t", "search", "F10"])
    tmux(["send-keys", "-t", "search", "-l", "Search current session"])
    if (options.disabled) {
      await waitFor(async () => pane().includes("Search current session"), "Command palette did not accept its query")
      expect(pane().split("Search current session").length).toBe(2)
      await closeSearch()
      tmux(["send-keys", "-t", "search", "F11"])
      tmux(["send-keys", "-t", "search", "-l", "DISABLED_SEARCH_DRAFT"])
      await waitFor(async () => pane().includes("DISABLED_SEARCH_DRAFT"), "Disabled search interfered with the composer")
      expect(pane()).not.toContain("Search current session")
      if (options.combined) await checkPromptSearch()
      return
    }
    await waitFor(async () => pane().split("Search current session").length >= 3, "Search command did not register")
    await closeSearch()
    const before = e2e.proxy.mock.getRequests().length
    const marker = String(target).padStart(3, "0")
    expect(pane()).not.toContain(`AGENT-ANCHOR-${marker}`)
    tmux(["send-keys", "-t", "search", "-l", "DRAFT_KEEP_ME"])
    await search(`AGENT-ANCHOR-${marker}`)
    if (options.compact) expect(pane()).toContain("before compaction")
    tmux(["send-keys", "-t", "search", "Enter"])
    await waitFor(async () => !pane().includes("Search current session") && pane().includes(`AGENT-ANCHOR-${marker}`), "Enter did not scroll to the old agent message")
    expect(pane()).toContain("DRAFT_KEEP_ME")
    tmux(["send-keys", "-t", "search", "F11"])
    await waitFor(async () => pane().includes("Search current session"), "Search did not reopen")
    tmux(["send-keys", "-t", "search", "-l", "USER-ANCHOR-0"])
    const matches = Math.min(100, count)
    await waitFor(async () => pane().includes(`${matches}/${matches} matches`) && !pane().includes("Loading history"), "Multi-result search did not finish")
    tmux(["send-keys", "-t", "search", ...Array.from({ length: 12 }, () => "Down")])
    const selectedUser = `USER-ANCHOR-${String(Math.min(99, count - 1) - 12).padStart(3, "0")}`
    await waitFor(async () => pane().includes(selectedUser), "Selected search row did not scroll into view")
    tmux(["send-keys", "-t", "search", "Enter"])
    await waitFor(async () => !pane().includes("Search current session") && pane().includes(selectedUser), "Arrow selection did not jump to its message")
    await search(`SECOND-AGENT-PART-${marker}`)
    tmux(["send-keys", "-t", "search", "Enter"])
    await waitFor(async () => !pane().includes("Search current session") && pane().includes(`SECOND-AGENT-PART-${marker}`), "Search did not locate the second agent text part")
    await search("USER-ANCHOR-000")
    tmux(["send-keys", "-t", "search", "Enter"])
    await waitFor(async () => !pane().includes("Search current session") && pane().includes("USER-ANCHOR-000"), "Enter did not scroll to the first user message")
    expect(pane()).toContain("DRAFT_KEEP_ME")
    expect(e2e.proxy.mock.getRequests().length).toBe(before)
    tmux(["send-keys", "-t", "search", "F6"])
    await waitFor(async () => pane().includes("USER-ANCHOR-001") && !pane().includes("USER-ANCHOR-000"), "Built-in next-user navigation retained a stale cursor")
    tmux(["send-keys", "-t", "search", "F7"])
    await waitFor(async () => pane().includes("USER-ANCHOR-000"), "Built-in previous-user navigation stopped working after search")
    const exported = (await api<any>(e2e, `/api/experimental/session/${sessionID}/export`)).data
    expect(exported.messages.filter((message: any) => message.type === "user")).toHaveLength(count)
    expect(JSON.stringify(exported.messages)).not.toContain("DRAFT_KEEP_ME")
    if (options.combined) await checkPromptSearch()
    tmux(["send-keys", "-t", "search", "F9"])
    await waitFor(async () => pane().includes(options.compact ? "Deterministic E2E test." : `AGENT-ANCHOR-${String(count - 1).padStart(3, "0")}`), "Built-in last-message navigation stopped working after search")
    e2e.proxy.mock.prependFixture({ match: { userMessage: "FOLLOW_AFTER_SEARCH", hasToolResult: false }, response: { content: "follow line\n".repeat(50) + "AFTER_SEARCH_FOLLOWED" } })
    await prompt(e2e, sessionID, "FOLLOW_AFTER_SEARCH")
    await waitFor(async () => pane().includes("AFTER_SEARCH_FOLLOWED"), "Returning to the bottom did not restore automatic reply following")
    // A different active session must never see cached text from the previous transcript.
    const other = await api<any>(e2e, "/api/session", { title: "OTHER_SEARCH_SCOPE", agent: "compaction-e2e", model: { providerID: "openai", id: "gpt-5.6-luna" }, location: { directory: e2e.workspace } })
    await prompt(e2e, other.data.id, "OTHER_SESSION_ONLY")
    tmux(["send-keys", "-t", "search", "F8"])
    await waitFor(async () => pane().includes("Sessions"), "Session picker did not open")
    tmux(["send-keys", "-t", "search", "-l", "OTHER_SEARCH_SCOPE"])
    await waitFor(async () => pane().includes("OTHER_SEARCH_SCOPE"), "Other session did not appear")
    tmux(["send-keys", "-t", "search", "Enter"])
    await waitFor(async () => pane().includes("OTHER_SESSION_ONLY") && !pane().includes("Sessions"), "Did not switch to the other session")
    tmux(["send-keys", "-t", "search", "F11"])
    await waitFor(async () => pane().includes("Search current session"), "Search did not open in the new session")
    tmux(["send-keys", "-t", "search", "-l", `AGENT-ANCHOR-${marker}`])
    await waitFor(async () => pane().includes("No matching dialogue") && !pane().includes("Loading history"), "Search reused text from another session")
    e2e.proxy.mock.prependFixture({ match: { userMessage: "LIVE_SEARCH_ONLY", hasToolResult: false }, response: { content: "LIVE_AGENT_NEEDLE" } })
    tmux(["send-keys", "-t", "search", "C-u"])
    tmux(["send-keys", "-t", "search", "-l", "LIVE_AGENT_NEEDLE"])
    await prompt(e2e, other.data.id, "LIVE_SEARCH_ONLY")
    await waitFor(async () => /\b1\/1 matches\b/.test(pane()) && pane().includes("LIVE_AGENT_NEEDLE"), "Live agent text did not update an open search")
    tmux(["send-keys", "-t", "search", "Enter"])
    await waitFor(async () => !pane().includes("Search current session") && pane().includes("LIVE_AGENT_NEEDLE"), "Live search result did not navigate")
    const live = (await api<any>(e2e, `/api/experimental/session/${other.data.id}/export`)).data
    expect(live.messages.filter((message: any) => message.type === "user" && message.text === "LIVE_SEARCH_ONLY")).toHaveLength(1)
    if (options.long) {
      const boundary = live.messages.find((message: any) => message.type === "user" && message.text === "LIVE_SEARCH_ONLY").id
      await api(e2e, `/api/session/${other.data.id}/revert/stage`, { messageID: boundary })
      await search("LIVE_AGENT_NEEDLE")
      expect(pane()).toContain("reverted, unavailable")
      tmux(["send-keys", "-t", "search", "Enter"])
      await waitFor(async () => pane().includes("currently reverted"), "Reverted result was not blocked")
      expect(pane()).toContain("Search current session")
      expect((await api<any>(e2e, `/api/session/${other.data.id}`)).data.revert.messageID).toBe(boundary)
      await api(e2e, `/api/session/${other.data.id}/revert/commit`, {})
      await waitFor(async () => pane().includes("No matching dialogue") && !pane().includes("Loading history"), "Committed revert left stale results in the open search")
      const reverted = (await api<any>(e2e, `/api/experimental/session/${other.data.id}/export`)).data
      expect(JSON.stringify(reverted.messages)).not.toContain("LIVE_AGENT_NEEDLE")
    }
    if (!pane().includes("Search current session")) {
      tmux(["send-keys", "-t", "search", "F11"])
      await waitFor(async () => pane().includes("Search current session"), "Search did not reopen before disabling")
    }
    const disabledConfig = { ...cliConfig, plugins: cliConfig.plugins.map((entry) => ({ ...entry, options: { ...entry.options, features: { ...features, sessionSearch: false } } })) }
    await writeFile(cliPath, JSON.stringify(disabledConfig))
    await waitFor(async () => !pane().includes("Search current session"), "Disabling session search left an orphaned search dialog")
    if (options.combined) await checkPromptSearch()
  } catch (error) {
    const log = await readFile(path.join(e2e.root, "xdg-data/opencode/log/opencode.log"), "utf8").catch(() => "")
    throw new Error(`${error instanceof Error ? error.message : String(error)}\n${pane()}\n${log.split("\n").filter((line) => /failed|Error/.test(line)).slice(-8).join("\n")}`)
  } finally { tmux(["kill-server"], false) }
}
