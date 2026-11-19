import { expect, test } from "bun:test"
import type { Context } from "@opencode/plugin/tui/context"
import { DEFAULT_MAX_PROMPTS, PromptIndexer, resolveMaxPrompts, type PromptEntry } from "../src/indexer.js"

type TestCache = {
  version: 1
  sessions: Record<string, { updated: number; inbox?: string; exported?: boolean; prompts: PromptEntry[]; truncatedAtMax?: number }>
}

test("prompt limit defaults to 2000 and accepts non-negative integers", () => {
  expect(DEFAULT_MAX_PROMPTS).toBe(2_000)
  expect(resolveMaxPrompts(undefined)).toBe(2_000)
  expect(resolveMaxPrompts(5_000)).toBe(5_000)
  expect(resolveMaxPrompts(0)).toBe(0)
  expect(resolveMaxPrompts(1.5)).toBe(2_000)
})

test("keeps the newest configured number of cached prompts, including deleted sessions", async () => {
  const cache: TestCache = {
    version: 1,
    sessions: {
      deleted: {
        updated: 3,
        prompts: [entry("one", 1), entry("three", 3)],
      },
      alsoDeleted: {
        updated: 2,
        prompts: [entry("two", 2, "alsoDeleted")],
      },
    },
  }
  const indexer = new PromptIndexer(contextFor(cache), 2)
  await indexer.refresh()

  expect(indexer.entries().map((prompt) => prompt.text)).toEqual(["three", "two"])
  expect(totalPrompts(cache)).toBe(2)
  expect(cache.sessions.deleted?.prompts.map((prompt) => prompt.text)).toEqual(["three"])
  expect(cache.sessions.alsoDeleted?.prompts.map((prompt) => prompt.text)).toEqual(["two"])
})

test("prunes older deleted prompts when a refresh adds newer prompts", async () => {
  const cache: TestCache = {
    version: 1,
    sessions: { deleted: { updated: 1, prompts: [entry("old", 1)] } },
  }
  const indexer = new PromptIndexer(
    contextFor(
      cache,
      [{ id: "live", time: { updated: 3 }, title: "live", location: { directory: "/live" } }],
      {
        live: [
          { id: "new-1", type: "user", text: "new-1", time: { created: 2 } },
          { id: "new-2", type: "user", text: "new-2", time: { created: 3 } },
        ],
      },
    ),
    2,
  )
  await indexer.refresh()

  expect(indexer.entries().map((prompt) => prompt.text)).toEqual(["new-2", "new-1"])
  expect(totalPrompts(cache)).toBe(2)
  expect(cache.sessions.deleted).toBeUndefined()
})

test("indexes queued inbox prompts, ignores non-user items, and deduplicates delivered messages", async () => {
  const cache: TestCache = { version: 1, sessions: {} }
  let exportCalls = 0
  const indexer = new PromptIndexer(
    contextFor(
      cache,
      [{ id: "live", time: { updated: 3 }, title: "live", location: { directory: "/live" } }],
      {
        live: [{ id: "delivered", type: "user", text: "delivered prompt", time: { created: 2 } }],
      },
      undefined,
      () => exportCalls++,
      {
        live: [
          { id: "delivered", type: "user", payload: { text: "delivered prompt" }, delivery: "queue", time: { created: 2 } },
          { id: "queued", type: "user", payload: { text: "queued prompt" }, delivery: "queue", time: { created: 4 } },
          { id: "synthetic", type: "synthetic", payload: { text: "synthetic prompt" }, delivery: "queue", time: { created: 5 } },
        ],
      },
    ),
  )

  await indexer.refresh()
  expect(indexer.entries().map((prompt) => prompt.text)).toEqual(["queued prompt", "delivered prompt"])
  expect(exportCalls).toBe(1)
  expect(cache.sessions.live?.inbox).toBeString()

  await indexer.refresh()
  expect(exportCalls).toBe(1)
})

test("removes a cancelled queued prompt after invalidating its session", async () => {
  const cache: TestCache = { version: 1, sessions: {} }
  const pending: Record<string, any[]> = {
    live: [{ id: "queued", type: "user", payload: { text: "queued prompt" }, delivery: "queue", time: { created: 4 } }],
  }
  const indexer = new PromptIndexer(contextFor(cache, [{ id: "live", time: { updated: 3 } }], {}, undefined, undefined, pending))

  await indexer.refresh()
  expect(indexer.entries().map((prompt) => prompt.text)).toEqual(["queued prompt"])

  pending.live = []
  indexer.invalidate("live")
  await indexer.refresh()
  expect(indexer.entries()).toEqual([])
})

test("retries the inbox after a transient inbox failure", async () => {
  const cache: TestCache = { version: 1, sessions: {} }
  let inboxCalls = 0
  const indexer = new PromptIndexer(
    contextFor(
      cache,
      [{ id: "live", time: { updated: 3 } }],
      { live: [{ id: "exported", type: "user", text: "exported prompt", time: { created: 2 } }] },
      undefined,
      undefined,
      { live: [{ id: "queued", type: "user", payload: { text: "queued prompt" }, delivery: "queue", time: { created: 4 } }] },
      () => {
        inboxCalls++
        if (inboxCalls === 1) throw new Error("temporary inbox failure")
      },
    ),
  )

  await indexer.refresh()
  expect(indexer.entries().map((prompt) => prompt.text)).toEqual(["exported prompt"])
  expect(cache.sessions.live?.inbox).toBeUndefined()

  await indexer.refresh()
  expect(inboxCalls).toBe(2)
  expect(indexer.entries().map((prompt) => prompt.text)).toEqual(["queued prompt", "exported prompt"])
  expect(cache.sessions.live?.inbox).toBeString()
})

test("keeps queued prompts visible when export fails and retries the transcript", async () => {
  const cache: TestCache = { version: 1, sessions: {} }
  let exportCalls = 0
  const indexer = new PromptIndexer(
    contextFor(
      cache,
      [{ id: "live", time: { updated: 3 } }],
      { live: [{ id: "exported", type: "user", text: "exported prompt", time: { created: 2 } }] },
      undefined,
      () => {
        exportCalls++
        if (exportCalls === 1) throw new Error("temporary export failure")
      },
      { live: [{ id: "queued", type: "user", payload: { text: "queued prompt" }, delivery: "queue", time: { created: 4 } }] },
    ),
  )

  await indexer.refresh()
  expect(indexer.entries().map((prompt) => prompt.text)).toEqual(["queued prompt"])
  expect(cache.sessions.live?.exported).toBe(false)

  await indexer.refresh()
  expect(exportCalls).toBe(2)
  expect(indexer.entries().map((prompt) => prompt.text)).toEqual(["queued prompt", "exported prompt"])
  expect(cache.sessions.live?.exported).toBe(true)
})

test("re-reads existing caches that predate inbox indexing", async () => {
  const cache: TestCache = {
    version: 1,
    sessions: { live: { updated: 3, prompts: [entry("old", 1, "live")] } },
  }
  let exportCalls = 0
  const indexer = new PromptIndexer(
    contextFor(
      cache,
      [{ id: "live", time: { updated: 3 } }],
      { live: [{ id: "old", type: "user", text: "old", time: { created: 1 } }] },
      undefined,
      () => exportCalls++,
      { live: [{ id: "queued", type: "user", payload: { text: "queued prompt" }, delivery: "queue", time: { created: 4 } }] },
    ),
  )

  await indexer.refresh()
  expect(exportCalls).toBe(1)
  expect(indexer.entries().map((prompt) => prompt.text)).toEqual(["queued prompt", "old"])
  expect(cache.sessions.live?.inbox).toBeString()
})

test("does not re-export live sessions after all of their prompts are pruned", async () => {
  const cache: TestCache = {
    version: 1,
    sessions: { live: { updated: 2, inbox: "", prompts: [entry("old", 1, "live")] } },
  }
  let exportCalls = 0
  const indexer = new PromptIndexer(
    contextFor(
      cache,
      [
        { id: "live", time: { updated: 2 } },
        { id: "newer", time: { updated: 3 }, title: "newer", location: { directory: "/newer" } },
      ],
      { newer: [{ id: "new", type: "user", text: "new", time: { created: 3 } }] },
      undefined,
      () => exportCalls++,
    ),
    1,
  )

  await indexer.refresh()
  expect(indexer.entries().map((prompt) => prompt.text)).toEqual(["new"])
  expect(cache.sessions.live?.prompts).toEqual([])
  expect(exportCalls).toBe(1)

  await indexer.refresh()
  expect(exportCalls).toBe(1)
})

test("re-indexes live sessions when the configured cap is raised", async () => {
  const cache: TestCache = {
    version: 1,
    sessions: {
      live: { updated: 3, prompts: [entry("newest", 3)], truncatedAtMax: 1 },
    },
  }
  let exportCalls = 0
  const indexer = new PromptIndexer(
    contextFor(
      cache,
      [{ id: "live", time: { updated: 3 } }],
      {
        live: [
          { id: "oldest", type: "user", text: "oldest", time: { created: 1 } },
          { id: "middle", type: "user", text: "middle", time: { created: 2 } },
          { id: "newest", type: "user", text: "newest", time: { created: 3 } },
        ],
      },
      undefined,
      () => exportCalls++,
    ),
    3,
  )

  await indexer.refresh()

  expect(exportCalls).toBe(1)
  expect(indexer.entries().map((prompt) => prompt.text)).toEqual(["newest", "middle", "oldest"])
  expect(cache.sessions.live?.truncatedAtMax).toBeUndefined()
})

test("retries a re-index after an export failure", async () => {
  const cache: TestCache = {
    version: 1,
    sessions: {
      live: { updated: 3, prompts: [entry("newest", 3)], truncatedAtMax: 1 },
    },
  }
  let exportCalls = 0
  const indexer = new PromptIndexer(
    contextFor(
      cache,
      [{ id: "live", time: { updated: 3 } }],
      {
        live: [
          { id: "oldest", type: "user", text: "oldest", time: { created: 1 } },
          { id: "middle", type: "user", text: "middle", time: { created: 2 } },
          { id: "newest", type: "user", text: "newest", time: { created: 3 } },
        ],
      },
      undefined,
      () => {
        exportCalls++
        if (exportCalls === 1) throw new Error("temporary export failure")
      },
    ),
    3,
  )

  await indexer.refresh()
  expect(indexer.entries().map((prompt) => prompt.text)).toEqual(["newest"])
  expect(cache.sessions.live?.truncatedAtMax).toBe(1)

  await indexer.refresh()
  expect(exportCalls).toBe(2)
  expect(indexer.entries().map((prompt) => prompt.text)).toEqual(["newest", "middle", "oldest"])
})

test("zero clears the prompt cache without exporting sessions", async () => {
  const cache: TestCache = {
    version: 1,
    sessions: { deleted: { updated: 1, prompts: [entry("old", 1)] } },
  }
  let listCalls = 0
  const context = contextFor(cache, [], {}, () => listCalls++)

  const indexer = new PromptIndexer(context, 0)
  await indexer.refresh()

  expect(indexer.entries()).toEqual([])
  expect(cache.sessions).toEqual({})
  expect(listCalls).toBe(0)
})

test("orders matching prompts strictly by newest first", () => {
  const cache: TestCache = {
    version: 1,
    sessions: {
      older: {
        updated: 10,
        prompts: [{
          sessionID: "older",
          messageID: "old-exact",
          text: "alpha",
          created: 1,
          directory: "/other",
          projectID: "other-project",
        }],
      },
      newer: {
        updated: 10,
        prompts: [{
          sessionID: "newer",
          messageID: "new-partial",
          text: "alpha beta",
          created: 9,
          directory: "/current",
          projectID: "current-project",
        }],
      },
    },
  }
  const indexer = new PromptIndexer(contextFor(cache))
  expect(indexer.search("alpha").map((prompt) => prompt.messageID)).toEqual(["new-partial", "old-exact"])
})

test("filters searches by project while all-project search stays available", () => {
  const cache: TestCache = {
    version: 1,
    sessions: {
      p1: {
        updated: 10,
        prompts: [{
          sessionID: "p1",
          messageID: "p1-new",
          text: "needle one",
          created: 9,
          projectID: "project-1",
        }],
      },
      p2: {
        updated: 10,
        prompts: [{
          sessionID: "p2",
          messageID: "p2-new",
          text: "needle two",
          created: 8,
          projectID: "project-2",
        }],
      },
      legacy: {
        updated: 10,
        prompts: [{
          sessionID: "legacy",
          messageID: "legacy",
          text: "needle legacy",
          created: 7,
        }],
      },
    },
  }
  const indexer = new PromptIndexer(contextFor(cache))
  expect(indexer.search("needle").map((prompt) => prompt.messageID)).toEqual(["p1-new", "p2-new", "legacy"])
  expect(indexer.search("needle", 100, { scope: "project", projectID: "project-1" }).map((prompt) => prompt.messageID)).toEqual(["p1-new"])
  expect(indexer.search("needle", 100, { scope: "project", projectID: "missing" })).toEqual([])
})

test("re-indexes a live session whose cache has no project IDs", async () => {
  const cache: TestCache = {
    version: 1,
    sessions: {
      live: { updated: 3, inbox: "", prompts: [entry("old", 1, "live")] },
    },
  }
  let exportCalls = 0
  const indexer = new PromptIndexer(
    contextFor(
      cache,
      [{ id: "live", projectID: "project-1", time: { updated: 3 } }],
      { live: [{ id: "old", type: "user", text: "old", time: { created: 1 } }] },
      undefined,
      () => exportCalls++,
    ),
  )
  await indexer.refresh()
  expect(exportCalls).toBe(1)
  expect(indexer.entries()[0]?.projectID).toBe("project-1")
})

test("does not index subagent sessions and removes their cached prompts", async () => {
  const cache: TestCache = {
    version: 1,
    sessions: {
      parent: { updated: 3, prompts: [] },
      child: { updated: 3, prompts: [entry("subagent-prompt", 1, "child")] },
    },
  }
  let exportCalls = 0
  const indexer = new PromptIndexer(
    contextFor(
      cache,
      [
        { id: "parent", time: { updated: 3 }, title: "parent" },
        { id: "child", parentID: "parent", time: { updated: 3 }, title: "child" },
      ],
      {
        parent: [{ id: "parent-prompt", type: "user", text: "parent prompt", time: { created: 2 } }],
        child: [{ id: "subagent-prompt", type: "user", text: "subagent prompt", time: { created: 1 } }],
      },
      undefined,
      () => exportCalls++,
    ),
  )
  await indexer.refresh()
  expect(indexer.entries().map((prompt) => prompt.text)).toEqual(["parent prompt"])
  expect(cache.sessions.child).toBeUndefined()
  expect(exportCalls).toBe(1)
})

test("requires every term, supports quoted phrases, exclusions, and match totals", () => {
  const cache: TestCache = {
    version: 1,
    sessions: {
      s: {
        updated: 10,
        prompts: [
          { sessionID: "s", messageID: "both", text: "alpha beta release", created: 5 },
          { sessionID: "s", messageID: "alpha", text: "alpha only", created: 4 },
          { sessionID: "s", messageID: "phrase", text: "alpha beta", created: 3 },
          { sessionID: "s", messageID: "excluded", text: "alpha beta gamma", created: 2 },
        ],
      },
    },
  }
  const indexer = new PromptIndexer(contextFor(cache))
  expect(indexer.search("alpha beta").map((prompt) => prompt.messageID)).toEqual(["both", "phrase", "excluded"])
  expect(indexer.search('"alpha beta"').map((prompt) => prompt.messageID)).toEqual(["both", "phrase", "excluded"])
  expect(indexer.search("alpha beta -gamma").map((prompt) => prompt.messageID)).toEqual(["both", "phrase"])
  expect(indexer.search("alpha -beta").map((prompt) => prompt.messageID)).toEqual(["alpha"])

  const page = indexer.searchPage("alpha beta", 1)
  expect(page.entries).toHaveLength(1)
  expect(page.total).toBe(3)
  expect(page.query.terms).toEqual(["alpha", "beta"])
})

function contextFor(
  cache: TestCache,
  sessions: any[] = [],
  messages: Record<string, any[]> = {},
  onList?: () => void,
  onExport?: () => void,
  pending: Record<string, any[]> = {},
  onInbox?: () => void,
) {
  return {
    storage: {
      store: () => [cache, async (mutate: (draft: TestCache) => void) => mutate(cache)],
    },
    client: {
      session: {
        list: async () => {
          onList?.()
          return { data: sessions, cursor: { next: undefined } }
        },
        export: async ({ sessionID }: { sessionID: string }) => {
          onExport?.()
          return { messages: messages[sessionID] ?? [] }
        },
        inbox: {
          list: async ({ sessionID }: { sessionID: string }) => {
            onInbox?.()
            return pending[sessionID] ?? []
          },
        },
      },
    },
  } as unknown as Context
}

function entry(messageID: string, created: number, sessionID = "deleted"): PromptEntry {
  return {
    sessionID,
    messageID,
    text: messageID,
    created,
  }
}

function totalPrompts(cache: TestCache) {
  return Object.values(cache.sessions).reduce((count, session) => count + session.prompts.length, 0)
}
