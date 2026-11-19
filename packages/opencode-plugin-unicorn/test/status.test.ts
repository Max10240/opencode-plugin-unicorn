import { expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { unicornRuntimeStatus } from "../src/status.js"

test("reports the loaded plugin version and repository state", async () => {
  const status = await unicornRuntimeStatus()
  const manifest = JSON.parse(await readFile(path.join(import.meta.dir, "..", "package.json"), "utf8"))
  expect(status.version).toBe(manifest.version)
  expect(status.packagePath.endsWith("opencode-plugin-unicorn")).toBe(true)
  expect(status.shadow).toBe(false)
  expect(status.repo).toBeString()
  expect(typeof status.dirty).toBe("boolean")
})
