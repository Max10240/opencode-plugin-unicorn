import { expect, test } from "bun:test"
import { access, mkdir, mkdtemp, readFile, readdir, readlink, rm, symlink, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { saveGeneratedImage } from "../src/output.js"

async function fixture(callback: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "image-gen-output-"))
  try { await callback(directory) }
  finally { await rm(directory, { recursive: true, force: true }) }
}

test("concurrent image saves reserve distinct paths without losing any generated image", async () => fixture(async (directory) => {
  const images = Array.from({ length: 24 }, (_, index) => Buffer.from(`IMAGE_${index}`))
  const results = await Promise.all(images.map((data) => saveGeneratedImage("image.png", directory, data)))
  expect(new Set(results.map((result) => result.savedPath)).size).toBe(images.length)
  for (const [index, result] of results.entries()) expect(await readFile(result.savedPath)).toEqual(images[index]!)
  expect(results.filter((result) => !result.versioned)).toHaveLength(1)
}))

test("saving keeps existing files and links untouched and preserves versioned names", async () => fixture(async (directory) => {
  await writeFile(path.join(directory, "existing.png"), "ORIGINAL")
  await symlink("existing.png", path.join(directory, "image.png"))
  await writeFile(path.join(directory, "image-v2.png"), "OLDER")
  const result = await saveGeneratedImage("image.png", directory, Buffer.from("NEW"))
  expect(result.savedPath).toBe(path.join(directory, "image-v3.png"))
  expect(result.versioned).toBe(true)
  expect(await readFile(path.join(directory, "existing.png"), "utf8")).toBe("ORIGINAL")
  expect(await readFile(path.join(directory, "image-v2.png"), "utf8")).toBe("OLDER")
  expect(await readFile(result.savedPath, "utf8")).toBe("NEW")
}))

test("saving creates nested directories and propagates non-collision filesystem errors", async () => fixture(async (directory) => {
  const result = await saveGeneratedImage("nested/image.png", directory, Buffer.from("NEW"))
  expect(result.savedPath).toBe(path.join(directory, "nested/image.png"))
  expect(result.versioned).toBe(false)
  await mkdir(path.join(directory, "blocked"))
  await writeFile(path.join(directory, "blocked/file"), "ORIGINAL")
  await expect(saveGeneratedImage("blocked/file/image.png", directory, Buffer.from("NEW"))).rejects.toThrow()
  expect(await readFile(path.join(directory, "blocked/file"), "utf8")).toBe("ORIGINAL")
}))

test("absolute and extensionless output paths keep the existing versioning convention", async () => fixture(async (directory) => {
  const first = await saveGeneratedImage("nested/image", directory, Buffer.from("FIRST"))
  const second = await saveGeneratedImage(first.savedPath, directory, Buffer.from("SECOND"))
  expect(first.savedPath).toBe(path.join(directory, "nested/image"))
  expect(second.savedPath).toBe(path.join(directory, "nested/image-v2"))
  expect(second.versioned).toBe(true)
  expect(await readFile(first.savedPath, "utf8")).toBe("FIRST")
  expect(await readFile(second.savedPath, "utf8")).toBe("SECOND")
}))

test("a dangling symlink is not followed or replaced when reserving an output file", async () => fixture(async (directory) => {
  await symlink("missing.png", path.join(directory, "image.png"))
  const saved = await saveGeneratedImage("image.png", directory, Buffer.from("NEW"))
  expect(saved.savedPath).toBe(path.join(directory, "image-v2.png"))
  expect(await readlink(path.join(directory, "image.png"))).toBe("missing.png")
  await expect(access(path.join(directory, "missing.png"))).rejects.toThrow()
  expect(await readFile(saved.savedPath, "utf8")).toBe("NEW")
}))

test("exhausted version names fail without overwriting existing files or exceeding the limit", async () => fixture(async (directory) => {
  for (let version = 1; version <= 999; version++) {
    await writeFile(path.join(directory, version === 1 ? "image.png" : `image-v${version}.png`), "EXISTING")
  }
  await expect(saveGeneratedImage("image.png", directory, Buffer.from("NEW"))).rejects.toThrow("Could not find a free output path")
  expect(await readdir(directory)).toHaveLength(999)
  expect(await readFile(path.join(directory, "image.png"), "utf8")).toBe("EXISTING")
  expect(await readFile(path.join(directory, "image-v999.png"), "utf8")).toBe("EXISTING")
}))
