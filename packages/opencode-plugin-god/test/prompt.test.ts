import { afterAll, describe, expect, test } from "bun:test"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { PromptLoader, expandHome, parseSource } from "../src/prompt.js"

const roots: string[] = []

async function tempRoot() {
  const root = await mkdtemp(path.join(tmpdir(), "god-prompt-"))
  roots.push(root)
  return root
}

afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })))
})

function createLoader(directory: string, overrides: Partial<ConstructorParameters<typeof PromptLoader>[0]> = {}) {
  return new PromptLoader({
    directory,
    cache: true,
    cacheTtlMs: 60_000,
    timeoutMs: 2_000,
    ...overrides,
  })
}

describe("expandHome", () => {
  test("expands a leading tilde", () => {
    expect(expandHome("~/prompts/a.md", "/home/user")).toBe("/home/user/prompts/a.md")
    expect(expandHome("~", "/home/user")).toBe("/home/user")
  })

  test("leaves other paths unchanged", () => {
    expect(expandHome("/absolute/a.md", "/home/user")).toBe("/absolute/a.md")
    expect(expandHome("relative/a.md", "/home/user")).toBe("relative/a.md")
  })
})

describe("parseSource", () => {
  test("recognizes HTTP and HTTPS URLs", () => {
    expect(parseSource("https://example.com/prompt.md", "/workspace")).toEqual({
      kind: "http",
      url: "https://example.com/prompt.md",
    })
    expect(parseSource("http://example.com/prompt.md", "/workspace")).toEqual({
      kind: "http",
      url: "http://example.com/prompt.md",
    })
  })

  test("converts file URLs", () => {
    const file = path.join("/workspace", "prompt.md")
    expect(parseSource(pathToFileURL(file).href, "/workspace")).toEqual({ kind: "file", filepath: file })
  })

  test("resolves relative paths against the workspace", () => {
    expect(parseSource("prompts/a.md", "/workspace")).toEqual({
      kind: "file",
      filepath: path.join("/workspace", "prompts/a.md"),
    })
  })

  test("expands tilde paths", () => {
    expect(parseSource("~/a.md", "/workspace", "/home/user")).toEqual({
      kind: "file",
      filepath: path.join("/home/user", "a.md"),
    })
  })
})

describe("PromptLoader local files", () => {
  test("reads a file relative to the workspace", async () => {
    const root = await tempRoot()
    await mkdir(path.join(root, "prompts"))
    await writeFile(path.join(root, "prompts", "a.md"), "local prompt")

    const result = await createLoader(root).load("prompts/a.md")
    expect(result).toEqual({ source: "prompts/a.md", text: "local prompt" })
  })

  test("reads a file URL", async () => {
    const root = await tempRoot()
    const file = path.join(root, "a.md")
    await writeFile(file, "file url prompt")

    const result = await createLoader(root).load(pathToFileURL(file).href)
    expect(result.text).toBe("file url prompt")
  })

  test("reloads a cached file when its size changes", async () => {
    const root = await tempRoot()
    const file = path.join(root, "a.md")
    const loader = createLoader(root)

    await writeFile(file, "one")
    expect((await loader.load("a.md")).text).toBe("one")

    await writeFile(file, "two-two")
    expect((await loader.load("a.md")).text).toBe("two-two")
  })

  test("keeps the cached text when the file is unchanged", async () => {
    const root = await tempRoot()
    const file = path.join(root, "a.md")
    const loader = createLoader(root)

    await writeFile(file, "one")
    expect((await loader.load("a.md")).text).toBe("one")

    await writeFile(file, "one")
    expect((await loader.load("a.md")).text).toBe("one")
  })

  test("returns an error for a missing file", async () => {
    const root = await tempRoot()
    const result = await createLoader(root).load("missing.md")
    expect(result.text).toBeUndefined()
    expect(result.error).toBeTruthy()
  })

  test("returns an error for a directory", async () => {
    const root = await tempRoot()
    await mkdir(path.join(root, "prompts"))
    const result = await createLoader(root).load("prompts")
    expect(result.error).toContain("not a file")
  })

  test("preserves an empty file", async () => {
    const root = await tempRoot()
    await writeFile(path.join(root, "empty.md"), "")
    const result = await createLoader(root).load("empty.md")
    expect(result.text).toBe("")
  })
})

describe("PromptLoader HTTP sources", () => {
  test("fetches a remote prompt and caches it", async () => {
    let requests = 0
    const server = Bun.serve({
      port: 0,
      fetch() {
        requests += 1
        return new Response("remote prompt")
      },
    })

    try {
      const source = `http://127.0.0.1:${server.port}/prompt.md`
      const root = await tempRoot()
      const loader = createLoader(root)

      expect((await loader.load(source)).text).toBe("remote prompt")
      expect((await loader.load(source)).text).toBe("remote prompt")
      expect(requests).toBe(1)
    } finally {
      server.stop(true)
    }
  })

  test("bypasses the cache when caching is disabled", async () => {
    let requests = 0
    const server = Bun.serve({
      port: 0,
      fetch() {
        requests += 1
        return new Response(`remote ${requests}`)
      },
    })

    try {
      const source = `http://127.0.0.1:${server.port}/prompt.md`
      const root = await tempRoot()
      const loader = createLoader(root, { cache: false })

      expect((await loader.load(source)).text).toBe("remote 1")
      expect((await loader.load(source)).text).toBe("remote 2")
      expect(requests).toBe(2)
    } finally {
      server.stop(true)
    }
  })

  test("returns an error for a non-success response", async () => {
    const server = Bun.serve({
      port: 0,
      fetch() {
        return new Response("missing", { status: 404 })
      },
    })

    try {
      const source = `http://127.0.0.1:${server.port}/missing.md`
      const root = await tempRoot()
      const result = await createLoader(root).load(source)
      expect(result.text).toBeUndefined()
      expect(result.error).toContain("404")
    } finally {
      server.stop(true)
    }
  })
})
