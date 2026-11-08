import { expect, setDefaultTimeout, test } from "bun:test"
import path from "node:path"
import { createOpenCodeE2E } from "../../opencode-plugin-unicorn/test/e2e-utils.js"
import { api, createSession, prompt } from "../../opencode-plugin-show-img/test/e2e-utils.js"
import { SessionSearchController } from "../src/controller.js"

setDefaultTimeout(120_000)

function controller(e2e: Awaited<ReturnType<typeof createOpenCodeE2E>>) {
  return new SessionSearchController({
    info: async (sessionID) => (await api<any>(e2e, `/api/session/${sessionID}`)).data,
    page: async (sessionID, type, cursor, signal) => {
      const query = new URLSearchParams({ type, limit: "200", ...(cursor ? { cursor } : { order: "desc" }) })
      const response = await fetch(`${e2e.baseURL}/api/session/${sessionID}/message?${query}`, {
        headers: { authorization: `Basic ${btoa("opencode:opencode-plugin-unicorn-e2e")}` },
        signal,
      })
      if (!response.ok) throw new Error(`message page failed: ${response.status}`)
      return await response.json() as any
    },
  }, () => {})
}

test("indexes real session history across compaction and scopes searches to the active session", async () => {
  const e2e = await createOpenCodeE2E({ plugin: "unicorn", pluginPackage: path.resolve(import.meta.dir, "../../opencode-plugin-unicorn/dist") })
  try {
    const seeded = await createSession(e2e, "Session-Search-Headless-Seed")
    await prompt(e2e, seeded, "SEED_SESSION_SEARCH")
    const original = (await api<any>(e2e, `/api/experimental/session/${seeded}/export`)).data
    const user = original.messages.find((message: any) => message.type === "user")
    const assistant = original.messages.find((message: any) => message.type === "assistant")
    const idle = original.messages.find((message: any) => message.type === "idle")
    const rootID = crypto.randomUUID().replaceAll("-", "")
    const messageID = (index: number) => `msg_00000000${String(index).padStart(6, "0")}${rootID}`
    const count = 260
    const target = 40
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
    const imported = await api<any>(e2e, "/api/experimental/session/import", {
      info: { ...original.info, id: `ses_headless_${rootID}`, title: "Session-Search-Headless" },
      messages,
      location: { directory: e2e.workspace },
    })
    const sessionID = imported.data.id
    await api(e2e, `/api/session/${sessionID}/compact`, {})
    await api(e2e, `/api/experimental/session/${sessionID}/wait`, {})

    const search = controller(e2e)
    try {
      await search.open(sessionID)
      expect(search.error).toBeUndefined()
      const targetMark = String(target).padStart(3, "0")
      const second = await search.index.search(`SECOND-AGENT-PART-${targetMark}`)
      expect(second.total).toBe(1)
      expect(second.matches[0]).toMatchObject({ role: "assistant", beforeCompaction: true })
      expect(second.matches[0].text).toContain("SECOND-AGENT-PART")
      const all = await search.index.search("USER-ANCHOR-0")
      expect(all.total).toBe(Math.min(100, count))
      expect(all.matches[0].text).toContain("USER-ANCHOR-")

      const other = await createSession(e2e, "OTHER_SEARCH_SCOPE")
      await prompt(e2e, other, "OTHER_SESSION_ONLY")
      await search.open(other)
      expect((await search.index.search(`AGENT-ANCHOR-${targetMark}`)).total).toBe(0)
      expect((await search.index.search("OTHER_SESSION_ONLY")).total).toBe(1)

      const live = await createSession(e2e, "LIVE_SEARCH_SCOPE")
      e2e.proxy.mock.prependFixture({ match: { userMessage: "LIVE_SEARCH_ONLY", hasToolResult: false }, response: { content: "LIVE_AGENT_NEEDLE" } })
      await prompt(e2e, live, "LIVE_SEARCH_ONLY")
      const exported = (await api<any>(e2e, `/api/experimental/session/${live}/export`)).data
      const boundary = exported.messages.find((message: any) => message.type === "user" && message.text === "LIVE_SEARCH_ONLY").id
      await search.open(live)
      expect((await search.index.search("LIVE_AGENT_NEEDLE")).total).toBe(1)
      await api(e2e, `/api/session/${live}/revert/stage`, { messageID: boundary })
      await search.open(live)
      expect((await search.index.search("LIVE_AGENT_NEEDLE")).matches[0]).toMatchObject({ reverted: true })
      await api(e2e, `/api/session/${live}/revert/commit`, {})
      await search.open(live)
      expect((await search.index.search("LIVE_AGENT_NEEDLE")).total).toBe(0)
    } finally {
      search.dispose()
    }
  } finally {
    await e2e.close()
  }
})
