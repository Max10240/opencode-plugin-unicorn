import { expect, setDefaultTimeout, test } from "bun:test"
import { mkdir, rm, symlink, truncate, writeFile } from "node:fs/promises"
import path from "node:path"
import { createOpenCodeE2E } from "../../opencode-plugin-unicorn/test/e2e-utils.js"
import { MAX_PREVIEW_BYTES } from "../src/preview-assets.js"
import { api, createSession, headers, previewEndpoint, showImage } from "./e2e-utils.js"
import { rasterFixtures } from "./fixtures.js"

setDefaultTimeout(180_000)

const start = () => createOpenCodeE2E({ plugin: "show-img", pluginPackage: path.resolve(import.meta.dir, "../dist") })

test("real tool rejects invalid files, exposes no preview IDs, and recovers on the next valid call", async () => {
  const e2e = await start()
  try {
    const sessionID = await createSession(e2e)
    const text = path.join(e2e.root, "not-image.png")
    const large = path.join(e2e.root, "large.png")
    const directory = path.join(e2e.root, "directory.png")
    await writeFile(text, "PRIVATE_NON_IMAGE_CONTENT")
    await writeFile(large, rasterFixtures[0].bytes)
    await truncate(large, MAX_PREVIEW_BYTES + 1)
    await mkdir(directory)
    for (const [file, error] of [
      ["relative.png", "absolute"], [path.join(e2e.root, "missing.png"), "ENOENT"],
      [text, "Only PNG"], [directory, "regular file"], [large, "20 MiB"],
    ]) {
      const part = await showImage(e2e, sessionID, file)
      expect(part.state.status).toBe("error")
      expect(JSON.stringify(part.state)).toContain(error)
      expect(part.state.metadata?.imagePreview).toBeUndefined()
      expect(JSON.stringify(part.state)).not.toContain("PRIVATE_NON_IMAGE_CONTENT")
    }
    const valid = path.join(e2e.root, "recovered.png")
    await writeFile(valid, rasterFixtures[0].bytes)
    expect((await showImage(e2e, sessionID, valid)).state.status).toBe("completed")
    expect(JSON.stringify(e2e.proxy.mock.getRequests().map((request) => request.body))).not.toContain("PRIVATE_NON_IMAGE_CONTENT")
  } finally { await e2e.close() }
})

test("real RPC transports all raster formats and rejects malformed input and arbitrary paths", async () => {
  const e2e = await start()
  try {
    const sessionID = await createSession(e2e)
    const ids = new Set<string>()
    for (const fixture of rasterFixtures) {
      const file = path.join(e2e.root, `${fixture.kind}.bin`)
      await writeFile(file, fixture.bytes)
      const part = await showImage(e2e, sessionID, file)
      expect(part.state.status).toBe("completed")
      const { assetID } = part.state.metadata.imagePreview
      ids.add(assetID)
      const result = await api<{ output: { mime: string; data: string } }>(e2e, previewEndpoint(e2e), { input: { sessionID, assetID } })
      expect(result.output.mime).toBe(fixture.mime)
      expect(Buffer.from(result.output.data, "base64")).toEqual(fixture.bytes)
      expect(JSON.stringify(part)).not.toContain(fixture.bytes.toString("base64"))
    }
    expect(ids.size).toBe(rasterFixtures.length)
    const otherSession = await createSession(e2e)
    for (const input of [null, {}, { sessionID, assetID: 42 }, { sessionID, abs_file_path: path.join(e2e.root, "png.bin") },
      { sessionID, assetID: "../../png.bin" }, { sessionID: otherSession, assetID: [...ids][0] }]) {
      const response = await fetch(`${e2e.baseURL}${previewEndpoint(e2e)}`, {
        method: "POST", headers: headers(), body: JSON.stringify({ input }), signal: AbortSignal.timeout(10_000),
      })
      expect(response.ok).toBe(false)
      expect(await response.text()).not.toContain(rasterFixtures[0].bytes.toString("base64"))
    }
  } finally { await e2e.close() }
})

test("IDs survive a real server restart and alias replacement; file changes and deletion fail safely", async () => {
  const e2e = await start()
  try {
    const sessionID = await createSession(e2e)
    const file = path.join(e2e.root, "original.png")
    const alias = path.join(e2e.root, "alias.png")
    await writeFile(file, rasterFixtures[0].bytes)
    await symlink(file, alias)
    const part = await showImage(e2e, sessionID, alias)
    expect(part.state.status).toBe("completed")
    const input = { sessionID, assetID: part.state.metadata.imagePreview.assetID }
    await rm(alias)
    await writeFile(alias, "PRIVATE_REPLACED_ALIAS")
    await e2e.restart()
    const result = await api<{ output: { data: string; name: string } }>(e2e, previewEndpoint(e2e), { input })
    expect(Buffer.from(result.output.data, "base64")).toEqual(rasterFixtures[0].bytes)
    expect(result.output.name).toBe("original.png")
    const exported = await api<{ data: { messages: unknown[] } }>(e2e, `/api/experimental/session/${sessionID}/export`)
    expect(JSON.stringify(exported.data.messages)).toContain(input.assetID)
    for (const change of [
      () => writeFile(file, rasterFixtures[1].bytes),
      async () => { await writeFile(file, rasterFixtures[0].bytes); await truncate(file, MAX_PREVIEW_BYTES + 1) },
      () => rm(file),
    ]) {
      await change()
      const response = await fetch(`${e2e.baseURL}${previewEndpoint(e2e)}`, {
        method: "POST", headers: headers(), body: JSON.stringify({ input }),
      })
      expect(response.ok).toBe(false)
      const error = await response.text()
      expect(error).toContain("Image preview is unavailable")
      expect(error).not.toContain(file)
      expect(error).not.toContain("PRIVATE_REPLACED_ALIAS")
    }
    await writeFile(file, rasterFixtures[0].bytes)
    expect((await api<{ output: { data: string } }>(e2e, previewEndpoint(e2e), { input })).output.data).toBe(rasterFixtures[0].bytes.toString("base64"))
  } finally { await e2e.close() }
})
