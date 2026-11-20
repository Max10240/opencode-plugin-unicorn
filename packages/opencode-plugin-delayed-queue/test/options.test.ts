import { expect, test } from "bun:test"
import {
  DEFAULT_KEYBIND,
  DEFAULT_RECHECK_MS,
  delayedQueueEnabled,
  parseDelayedQueueOptions,
  WAIT_KINDS,
} from "../src/options.js"

test("uses the documented defaults", () => {
  expect(parseDelayedQueueOptions()).toEqual({
    enabled: true,
    keybind: DEFAULT_KEYBIND,
    queueKeybind: "f9",
    recheckMs: DEFAULT_RECHECK_MS,
    waitKinds: WAIT_KINDS,
    waitDescendants: true,
    pauseOnInterrupt: true,
    pauseOnFailure: true,
  })
})

test("honors independent feature and nested enabled switches", () => {
  expect(delayedQueueEnabled({})).toBe(true)
  expect(delayedQueueEnabled({ enabled: false })).toBe(false)
  expect(delayedQueueEnabled({ features: { delayedQueue: false } })).toBe(false)
  expect(delayedQueueEnabled({ features: { deadLoop: false } })).toBe(true)
})

test("accepts a custom keybind and allows disabling it", () => {
  expect(parseDelayedQueueOptions({ keybind: "ctrl+shift+q" }).keybind).toBe("ctrl+shift+q")
  expect(parseDelayedQueueOptions({ keybind: false }).keybind).toBe(false)
  expect(parseDelayedQueueOptions({ queueKeybind: "f8" }).queueKeybind).toBe("f8")
  expect(() => parseDelayedQueueOptions({ keybind: "" })).toThrow("keybind")
})

test("validates and deduplicates background kinds", () => {
  expect(parseDelayedQueueOptions({ waitKinds: ["shell", "shell", "subagent"] }).waitKinds).toEqual([
    "shell",
    "subagent",
  ])
  expect(() => parseDelayedQueueOptions({ waitKinds: ["shell", "unknown"] })).toThrow("waitKinds")
  expect(() => parseDelayedQueueOptions({ waitKinds: "shell" })).toThrow("waitKinds")
})

test("validates numeric and boolean options", () => {
  expect(parseDelayedQueueOptions({ recheckMs: 2_500 }).recheckMs).toBe(2_500)
  expect(() => parseDelayedQueueOptions({ recheckMs: 1 })).toThrow("recheckMs")
  expect(() => parseDelayedQueueOptions({ waitDescendants: "yes" })).toThrow("waitDescendants")
  expect(parseDelayedQueueOptions({ waitDescendants: false }).waitDescendants).toBe(false)
})
