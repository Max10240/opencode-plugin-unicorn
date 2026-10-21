import { expect, test } from "bun:test"
import { eventForSession, searchEvent } from "../src/events.js"

test("only dialogue events trigger indexing work; structural changes invalidate old text", () => {
  for (const type of ["session.tool.output.delta", "session.reasoning.delta", "session.renamed", "session.compaction.started", "session.compaction.delta", "session.compaction.failed"]) expect(searchEvent(type)).toBeUndefined()
  expect(searchEvent("session.text.delta")).toBe("text")
  expect(searchEvent("session.execution.failed")).toBe("settled")
  for (const type of ["session.compaction.ended", "session.revert.committed", "session.inbox.cancelled", "session.deleted"]) expect(searchEvent(type)).toBe("reload")
  expect(eventForSession("session.text.delta", { sessionID: "other" }, "current")).toBeUndefined()
  expect(eventForSession("session.text.delta", undefined, "current")).toBeUndefined()
  expect(eventForSession("session.text.delta", { sessionID: "current" })).toBeUndefined()
  expect(eventForSession("session.text.delta", { sessionID: "current" }, "current")).toBe("text")
})
