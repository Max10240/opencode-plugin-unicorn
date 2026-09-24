import { expect, test } from "bun:test"
import type { Context } from "@opencode/plugin/tui/context"
import { DEFAULT_MAX_PROMPTS, PromptIndexer, resolveMaxPrompts, type PromptEntry } from "../src/indexer.js"

type TestCache = {
  version: 1
  sessions: Record<string, { updated: number; prompts: PromptEntry[]; truncatedAtMax?: number }>
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

test("does not re-export live sessions after all of their prompts are pruned", async () => {
  const cache: TestCache = {
    version: 1,
    sessions: { live: { updated: 2, prompts: [entry("old", 1, "live")] } },
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

function contextFor(
  cache: TestCache,
  sessions: any[] = [],
  messages: Record<string, any[]> = {},
  onList?: () => void,
  onExport?: () => void,
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
