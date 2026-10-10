import { expect, test } from "bun:test"
import type { Context } from "@opencode/plugin/promise/plugin"
import { setupShowImg } from "../src/index.js"

test("removes both tool and RPC registrations during cleanup", async () => {
  const disposed: string[] = []
  const names: string[] = []
  const context = {
    storage: {},
    rpc: { register: async () => ({ dispose: async () => { disposed.push("rpc") } }) },
    tool: { transform: async (edit: (editor: { add: (tool: { name: string }) => void }) => void) => {
      edit({ add: (tool) => { names.push(tool.name) } })
      return { dispose: async () => { disposed.push("tool") } }
    } },
  } as unknown as Context
  const cleanup = await setupShowImg(context)
  expect(names).toEqual(["show_img"])
  expect(disposed).toEqual([])
  await cleanup()
  expect(disposed).toEqual(["tool", "rpc"])
})

test("disposes the already registered RPC if tool registration fails", async () => {
  let disposed = false
  const context = {
    storage: {},
    rpc: { register: async () => ({ dispose: async () => { disposed = true } }) },
    tool: { transform: async () => { throw new Error("tool registration failed") } },
  } as unknown as Context
  await expect(setupShowImg(context)).rejects.toThrow("tool registration failed")
  expect(disposed).toBe(true)
})

test("RPC cleanup still runs if disposing the tool registration fails", async () => {
  let rpcDisposed = false
  const context = {
    storage: {},
    rpc: { register: async () => ({ dispose: async () => { rpcDisposed = true } }) },
    tool: { transform: async () => ({ dispose: async () => { throw new Error("tool cleanup failed") } }) },
  } as unknown as Context
  const cleanup = await setupShowImg(context)
  await expect(cleanup()).rejects.toThrow("tool cleanup failed")
  expect(rpcDisposed).toBe(true)
})
