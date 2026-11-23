import { describe, expect, test } from "bun:test"
import { blocksQuestion } from "../src/question.js"

function gate(loops: readonly string[], parents: Record<string, string | undefined> = {}) {
  const owned = new Set(loops)
  return {
    hasLoop: (sessionID: string) => owned.has(sessionID),
    parentOf: (sessionID: string) => parents[sessionID],
  }
}

describe("blocksQuestion", () => {
  test("blocks a question in a session that owns a loop", () => {
    expect(blocksQuestion("s1", gate(["s1"]))).toBe(true)
  })

  test("allows a question in an unrelated session", () => {
    expect(blocksQuestion("s2", gate(["s1"]))).toBe(false)
    expect(blocksQuestion("s2", gate([]))).toBe(false)
  })

  test("blocks a subagent question when an ancestor owns the loop", () => {
    expect(blocksQuestion("child", gate(["root"], { child: "root" }))).toBe(true)
    expect(blocksQuestion("grandchild", gate(["root"], { grandchild: "child", child: "root" }))).toBe(true)
    expect(blocksQuestion("child", gate(["other"], { child: "root" }))).toBe(false)
  })

  test("a parent cycle does not hang", () => {
    expect(blocksQuestion("a", gate([], { a: "b", b: "a" }))).toBe(false)
    expect(blocksQuestion("a", gate(["a"], { a: "a" }))).toBe(true)
  })
})
