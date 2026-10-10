import { expect, test } from "bun:test"
import { disposeAll, disposeAllSync } from "../src/cleanup.js"

test("server cleanup attempts every plugin in reverse order even when one fails", async () => {
  const calls: string[] = []
  const error = new Error("failure")
  await expect(disposeAll([
    async () => { calls.push("first") },
    async () => { calls.push("second"); throw error },
    async () => { calls.push("third") },
  ])).rejects.toBeInstanceOf(AggregateError)
  expect(calls).toEqual(["third", "second", "first"])
  await disposeAll([])
})

test("TUI cleanup does not leave other plugins registered after a failure", () => {
  const calls: string[] = []
  expect(() => disposeAllSync([
    () => { calls.push("first") },
    () => { calls.push("second"); throw new Error("failure") },
    () => { calls.push("third") },
  ])).toThrow(AggregateError)
  expect(calls).toEqual(["third", "second", "first"])
  expect(() => disposeAllSync([])).not.toThrow()
})
