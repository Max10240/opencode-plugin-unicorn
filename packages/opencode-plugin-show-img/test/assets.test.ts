import { expect, test } from "bun:test"
import { mkdtemp, rm, symlink, truncate, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { Context } from "@opencode/plugin/promise/plugin"
import { createPreviewAssets, MAX_PREVIEW_BYTES } from "../src/preview-assets.js"
import { previewReference, showImgEnabled } from "../src/preview-rpc.js"

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64")

function storage() {
  const values = new Map<string, Parameters<Context["storage"]["set"]>[1]>()
  return {
    values,
    get: async (key: string) => values.get(key),
    set: async (key: string, value: Parameters<Context["storage"]["set"]>[1]) => { values.set(key, value) },
  }
}

async function fixture(run: (root: string) => Promise<void>) {
  const root = await mkdtemp(path.join(os.tmpdir(), "opencode-show-img-assets-"))
  try { await run(root) } finally { await rm(root, { recursive: true, force: true }) }
}

test("persists only an opaque reference and transfers bytes through the separate reader", async () => {
  await fixture(async (root) => {
    const file = path.join(root, "private.png")
    await writeFile(file, png)
    const store = storage()
    const assets = createPreviewAssets(store)
    const reference = await assets.register("session-a", file)
    expect(reference.name).toBe("private.png")
    expect(reference.assetID).toMatch(/^[0-9a-f-]{36}$/)
    expect(JSON.stringify(reference)).not.toContain(file)
    expect(JSON.stringify([...store.values.values()])).not.toContain(png.toString("base64"))
    expect(JSON.stringify([...store.values.values()])).not.toContain("data:image/")
    expect(store.values.size).toBe(1)
    const image = await assets.read("session-a", reference.assetID)
    expect(image.mime).toBe("image/png")
    expect(Buffer.from(image.data, "base64")).toEqual(png)
    // References survive recreating the server-side plugin with the same durable storage.
    expect(await createPreviewAssets(store).read("session-a", reference.assetID)).toEqual(image)
    await expect(assets.read("session-b", reference.assetID)).rejects.toThrow("unavailable")
    await expect(assets.read("session-a", "unknown-id")).rejects.toThrow("unavailable")
  })
})

test("rejects relative paths, non-images, directories, missing and oversized files", async () => {
  await fixture(async (root) => {
    const assets = createPreviewAssets(storage())
    const text = path.join(root, "not-an-image.png")
    await writeFile(text, "private text must not be returned")
    const large = path.join(root, "large.png")
    await writeFile(large, png)
    await truncate(large, MAX_PREVIEW_BYTES + 1)
    await expect(assets.register("session", "relative.png")).rejects.toThrow("absolute")
    await expect(assets.register("session", text)).rejects.toThrow("Only PNG")
    await expect(assets.register("session", root)).rejects.toThrow("regular file")
    await expect(assets.register("session", path.join(root, "missing.png"))).rejects.toThrow()
    await expect(assets.register("session", large)).rejects.toThrow("20 MiB")
  })
})

test("canonicalizes symlinks and does not follow a replaced alias during UI reads", async () => {
  await fixture(async (root) => {
    const file = path.join(root, "private.png")
    const alias = path.join(root, "alias.png")
    await writeFile(file, png)
    await symlink(file, alias)
    const assets = createPreviewAssets(storage())
    const reference = await assets.register("session", alias)
    await rm(alias)
    await writeFile(alias, "not the registered image")
    expect(Buffer.from((await assets.read("session", reference.assetID)).data, "base64")).toEqual(png)
    await rm(file)
    await expect(assets.read("session", reference.assetID)).rejects.toThrow()
  })
})

test("recognizes raster signatures rather than trusting filename extensions", async () => {
  await fixture(async (root) => {
    const assets = createPreviewAssets(storage())
    const headers = [
      ["jpeg", Buffer.from([255, 216, 255, 224])],
      ["gif", Buffer.from("GIF89a")],
      ["webp", Buffer.from("RIFF0000WEBP")],
    ] as const
    for (const [kind, bytes] of headers) {
      const file = path.join(root, `${kind}.bin`)
      await writeFile(file, bytes)
      const reference = await assets.register("session", file)
      expect((await assets.read("session", reference.assetID)).mime).toBe(`image/${kind}`)
    }
  })
})

test("metadata parsing and feature toggles contain no image transport data", () => {
  expect(previewReference(undefined)).toBeUndefined()
  expect(previewReference({ imagePreview: "wrong" })).toBeUndefined()
  expect(previewReference({ imagePreview: { assetID: 1, name: "file.png" } })).toBeUndefined()
  expect(previewReference({ imagePreview: { assetID: "id", name: "file.png" } })).toEqual({ assetID: "id", name: "file.png" })
  expect(showImgEnabled({})).toBe(true)
  expect(showImgEnabled({ features: { showImg: false } })).toBe(false)
  expect(showImgEnabled({ features: { imageGen: false } })).toBe(true)
})

test("accepts the exact size limit and rejects growth and type changes after registration", async () => {
  await fixture(async (root) => {
    const file = path.join(root, "boundary.png")
    await writeFile(file, png)
    await truncate(file, MAX_PREVIEW_BYTES)
    const assets = createPreviewAssets(storage())
    const reference = await assets.register("session", file)
    expect(Buffer.from((await assets.read("session", reference.assetID)).data, "base64").length).toBe(MAX_PREVIEW_BYTES)
    await truncate(file, MAX_PREVIEW_BYTES + 1)
    await expect(assets.read("session", reference.assetID)).rejects.toThrow("20 MiB")
    await writeFile(file, Buffer.from("GIF89a"))
    await expect(assets.read("session", reference.assetID)).rejects.toThrow("type has changed")
  })
})

test("cancelled RPC reads reject without returning image data", async () => {
  await fixture(async (root) => {
    const file = path.join(root, "cancel.png")
    await writeFile(file, png)
    const assets = createPreviewAssets(storage())
    const reference = await assets.register("session", file)
    await expect(assets.read("session", reference.assetID, AbortSignal.abort())).rejects.toThrow()
    expect((await assets.read("session", reference.assetID)).mime).toBe("image/png")
  })
})

test("failed storage writes do not return a prepared reference", async () => {
  await fixture(async (root) => {
    const file = path.join(root, "failed-store.png")
    await writeFile(file, png)
    const store = storage()
    const assets = createPreviewAssets({ ...store, set: async () => { throw new Error("storage unavailable") } })
    await expect(assets.register("session", file)).rejects.toThrow("storage unavailable")
    expect(store.values.size).toBe(0)
  })
})
