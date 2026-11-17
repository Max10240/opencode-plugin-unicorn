import { expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { acquireHub } from "../src/hub.js"

test("a disabled higher-priority source falls back to an active lower-priority source", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sensitive-hub-"))
  const file = path.join(root, "secret.txt")
  await writeFile(file, "HUB_SECRET_123\n")
  const hub = await acquireHub(root, 1024 * 1024)
  try {
    await hub.addManual({
      path: file,
      format: "line",
      keys: ["line"],
      createdAt: Date.now(),
    }, [{ value: "HUB_SECRET_123", key: "line" }])
    await hub.disable({ path: file, source: "config", project: root })
    const active = hub.catalog().find((entry) => entry.path === file)
    expect(active?.source).toBe("manual")
    expect(active?.disabled).toBeUndefined()

    await hub.disable({ path: file, source: "manual" })
    const disabled = hub.catalog().find((entry) => entry.path === file)
    expect(disabled?.disabled).toBe(true)
    expect(disabled?.source).toBe("manual")
  } finally {
    await hub.release()
    await rm(root, { recursive: true, force: true })
  }
})
