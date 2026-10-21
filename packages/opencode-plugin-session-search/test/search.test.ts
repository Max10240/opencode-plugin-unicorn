import { expect, test } from "bun:test"
import { entriesFor, queuedMessage, TranscriptIndex } from "../src/search.js"

test("indexes only user and visible agent text, preserving empty text ordinals", () => {
  expect(entriesFor({ id: "u", type: "user", text: "hello" })[0].role).toBe("user")
  const entries = entriesFor({ id: "a", type: "assistant", content: [{ type: "reasoning", text: "PRIVATE_REASONING" }, { type: "tool", text: "PRIVATE_TOOL" }, { type: "text", text: "" }, { type: "text", text: "agent answer" }] })
  expect(entries).toHaveLength(1)
  expect(entries[0].ordinal).toBe(1)
  expect(JSON.stringify(entries)).not.toContain("PRIVATE_")
  expect(entriesFor({ id: "s", type: "system", text: "system" })).toEqual([])
  expect(queuedMessage("u", [{ id: "u", type: "user" }])).toBe(true)
  expect(queuedMessage("u", [{ id: "other", type: "user" }, { id: "u", type: "compaction" }])).toBe(false)
})

test("searches all history, including pre-compaction text and reverted entries, without truncating long messages", async () => {
  const index = new TranscriptIndex()
  index.upsert({ id: "a", type: "user", time: { created: 1 }, text: "prefix ".repeat(20_000) + "罕见 TARGET 词语\u001b[31m" })
  index.upsert({ id: "c", type: "compaction", status: "completed", time: { created: 2 } })
  index.upsert({ id: "d", type: "assistant", time: { created: 3 }, content: [{ type: "text", text: "TARGET later" }] })
  index.revertID = "d"
  const found = await index.search("target 罕见")
  expect(found.total).toBe(1)
  expect(found.matches[0].beforeCompaction).toBe(true)
  expect(found.matches[0].preview).toContain("TARGET")
  expect(found.matches[0].preview).not.toContain("\u001b")
  expect((await index.search("target")).matches[0].reverted).toBe(true)
  expect((await index.search("x".repeat(257))).error).toContain("256")
})

test("streaming edits replace text rather than duplicate it, and removals clear entries", async () => {
  const index = new TranscriptIndex()
  index.upsert({ id: "a", type: "assistant", content: [{ type: "text", text: "old" }] })
  index.upsert({ id: "a", type: "assistant", content: [{ type: "text", text: "new" }] })
  expect(index.size).toBe(1)
  expect((await index.search("old")).total).toBe(0)
  expect((await index.search("new")).total).toBe(1)
  index.upsert({ id: "a", type: "assistant", content: [] })
  expect(index.size).toBe(0)
  index.clear()
  expect(index.entries()).toEqual([])
})

test("unchanged text still updates its anchor when an empty text part shifts the ordinal", async () => {
  const index = new TranscriptIndex()
  index.upsert({ id: "a", type: "assistant", content: [{ type: "text", text: "same answer" }] })
  expect(index.upsert({ id: "a", type: "assistant", content: [{ type: "text", text: "" }, { type: "text", text: "same answer" }] })).toBe(true)
  expect((await index.search("answer")).matches[0].ordinal).toBe(1)
  expect(index.size).toBe(1)
})

test("large searches yield work, count matches beyond the display limit and cancel obsolete queries", async () => {
  const index = new TranscriptIndex()
  for (let i = 0; i < 10_000; i++) index.upsert({ id: String(i), type: "user", text: `common message unique-${i}`, time: { created: i } })
  let yields = 0
  const result = await index.search("common", undefined, 100, async () => { yields++ })
  expect(result.total).toBe(10_000)
  expect(result.matches).toHaveLength(100)
  expect(yields).toBeGreaterThan(30)
  let emptyYields = 0
  expect((await index.search("", undefined, 100, async () => { emptyYields++ })).total).toBe(10_000)
  expect(emptyYields).toBe(0)
  expect((await index.search("unique-1234", undefined, 100, async () => {})).matches[0].messageID).toBe("1234")
  const abort = new AbortController()
  await expect(index.search("common", abort.signal, 100, async () => { abort.abort() })).rejects.toThrow()
})
