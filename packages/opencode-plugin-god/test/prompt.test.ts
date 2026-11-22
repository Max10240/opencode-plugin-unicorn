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

  test("returns an error when a cached file disappears", async () => {
    const root = await tempRoot()
    const file = path.join(root, "prompt.md")
    await writeFile(file, "LOCAL")
    const loader = createLoader(root)

    expect((await loader.load("prompt.md")).text).toBe("LOCAL")
    await rm(file)
    expect((await loader.load("prompt.md")).error).toContain("ENOENT")
  })

  test("loads a large file without truncation", async () => {
    const root = await tempRoot()
    const text = "x".repeat(200_000)
    await writeFile(path.join(root, "large.md"), text)
    const result = await createLoader(root).load("large.md")
    expect(result.text?.length).toBe(text.length)
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

  test("shares one request between concurrent loads", async () => {
    let requests = 0
    const loader = createLoader(await tempRoot(), {
      fetchImpl: (async () => {
        requests += 1
        await Bun.sleep(10)
        return new Response("SHARED")
      }) as unknown as typeof fetch,
    })
    const source = "https://example.test/prompt.md"

    const results = await Promise.all([loader.load(source), loader.load(source)])

    expect(results.map((result) => result.text)).toEqual(["SHARED", "SHARED"])
    expect(requests).toBe(1)
  })

  test("returns an error when the request times out", async () => {
    const server = Bun.serve({
      port: 0,
      async fetch() {
        await Bun.sleep(200)
        return new Response("late")
      },
    })

    try {
      const loader = createLoader(await tempRoot(), { timeoutMs: 50 })
      const result = await loader.load(`http://127.0.0.1:${server.port}/slow.md`)
      expect(result.text).toBeUndefined()
      expect(result.error).toBeDefined()
    } finally {
      server.stop(true)
    }
  })

  test("follows a redirect", async () => {
    let target = ""
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        const pathname = new URL(request.url).pathname
        if (pathname === "/moved.md") return Response.redirect(target, 302)
        return new Response("REDIRECTED")
      },
    })
    target = `http://127.0.0.1:${server.port}/final.md`

    try {
      const result = await createLoader(await tempRoot()).load(`http://127.0.0.1:${server.port}/moved.md`)
      expect(result.text).toBe("REDIRECTED")
    } finally {
      server.stop(true)
    }
  })
})

function memorySlot() {
  const data = new Map<string, string>()
  return {
    data,
    get: async (key: string) => data.get(key),
    set: async (key: string, value: string) => {
      data.set(key, value)
    },
  }
}

function remoteFetch(read: () => Response) {
  return (async () => read()) as unknown as typeof fetch
}

async function waitFor(check: () => Promise<boolean>) {
  const deadline = Date.now() + 1_000
  while (Date.now() < deadline) {
    if (await check()) return
    await Bun.sleep(1)
  }
  throw new Error("timed out waiting for the background refresh")
}

describe("PromptLoader storage cache", () => {
  test("writes a fetched prompt to storage and reuses it in a new loader", async () => {
    let requests = 0
    const slot = memorySlot()
    const source = "https://example.test/prompt.md"
    const first = createLoader(await tempRoot(), {
      storage: slot,
      fetchImpl: remoteFetch(() => {
        requests += 1
        return new Response("remote prompt")
      }),
    })

    expect((await first.load(source)).text).toBe("remote prompt")
    expect(slot.data.size).toBe(1)

    const second = createLoader(await tempRoot(), {
      storage: slot,
      fetchImpl: remoteFetch(() => {
        requests += 1
        return new Response("unexpected")
      }),
    })

    expect((await second.load(source)).text).toBe("remote prompt")
    expect(requests).toBe(1)
  })

  test("serves a stale stored prompt and refreshes it in the background", async () => {
    const slot = memorySlot()
    const source = "https://example.test/prompt.md"
    slot.data.set(`god:prompt:v1:${source}`, JSON.stringify({ text: "old", fetchedAt: 0 }))

    let requests = 0
    const loader = createLoader(await tempRoot(), {
      storage: slot,
      now: () => 1_000_000,
      fetchImpl: remoteFetch(() => {
        requests += 1
        return new Response("new")
      }),
    })

    expect((await loader.load(source)).text).toBe("old")
    await waitFor(async () => (await loader.load(source)).text === "new")
    expect(requests).toBe(1)
    expect(JSON.parse(slot.data.get(`god:prompt:v1:${source}`) ?? "{}").text).toBe("new")
  })

  test("keeps the stored prompt when the background refresh fails", async () => {
    const slot = memorySlot()
    const source = "https://example.test/prompt.md"
    slot.data.set(`god:prompt:v1:${source}`, JSON.stringify({ text: "old", fetchedAt: 0 }))

    let requests = 0
    const loader = createLoader(await tempRoot(), {
      storage: slot,
      now: () => 1_000_000,
      fetchImpl: remoteFetch(() => {
        requests += 1
        return new Response("nope", { status: 500 })
      }),
    })

    expect((await loader.load(source)).text).toBe("old")
    await waitFor(async () => requests === 1)
    await Bun.sleep(5)
    expect((await loader.load(source)).text).toBe("old")
    expect(JSON.parse(slot.data.get(`god:prompt:v1:${source}`) ?? "{}").text).toBe("old")
    // The failed refresh is not retried on every request.
    expect((await loader.load(source)).text).toBe("old")
    expect(requests).toBe(1)
  })

  test("retries a failed source only after the retry window", async () => {
    let requests = 0
    let clock = 1_000_000
    const loader = createLoader(await tempRoot(), {
      now: () => clock,
      fetchImpl: remoteFetch(() => {
        requests += 1
        return new Response("nope", { status: 500 })
      }),
    })
    const source = "https://example.test/prompt.md"

    expect((await loader.load(source)).error).toContain("500")
    expect((await loader.load(source)).error).toBeDefined()
    expect(requests).toBe(1)

    clock += 300_001
    expect((await loader.load(source)).error).toContain("500")
    expect(requests).toBe(2)
  })

  test("ignores a malformed stored entry", async () => {
    const slot = memorySlot()
    const source = "https://example.test/prompt.md"
    slot.data.set(`god:prompt:v1:${source}`, "not json")

    const loader = createLoader(await tempRoot(), {
      storage: slot,
      fetchImpl: remoteFetch(() => new Response("fresh")),
    })

    expect((await loader.load(source)).text).toBe("fresh")
    expect(JSON.parse(slot.data.get(`god:prompt:v1:${source}`) ?? "{}").text).toBe("fresh")
  })

  test("ignores a stored entry with the wrong shape", async () => {
    const slot = memorySlot()
    const source = "https://example.test/prompt.md"
    slot.data.set(`god:prompt:v1:${source}`, JSON.stringify({ text: 42, fetchedAt: "now" }))

    const loader = createLoader(await tempRoot(), {
      storage: slot,
      fetchImpl: remoteFetch(() => new Response("fresh")),
    })

    expect((await loader.load(source)).text).toBe("fresh")
  })

  test("recovers after the retry window when the source comes back", async () => {
    let requests = 0
    let online = false
    let clock = 1_000_000
    const loader = createLoader(await tempRoot(), {
      now: () => clock,
      fetchImpl: (async () => {
        requests += 1
        return online ? new Response("back") : new Response("down", { status: 503 })
      }) as unknown as typeof fetch,
    })
    const source = "https://example.test/prompt.md"

    expect((await loader.load(source)).error).toContain("503")
    online = true
    clock += 300_001

    expect((await loader.load(source)).text).toBe("back")
    expect((await loader.load(source)).text).toBe("back")
    expect(requests).toBe(2)
  })

  test("treats a blank response as an error and does not cache it", async () => {
    let requests = 0
    const slot = memorySlot()
    const loader = createLoader(await tempRoot(), {
      storage: slot,
      fetchImpl: (async () => {
        requests += 1
        return new Response("   \n")
      }) as unknown as typeof fetch,
    })
    const source = "https://example.test/prompt.md"

    expect((await loader.load(source)).error).toBe("empty response")
    expect(slot.data.size).toBe(0)
    expect((await loader.load(source)).error).toBeDefined()
    expect(requests).toBe(1)
  })

  test("ignores a stored entry with blank text", async () => {
    const slot = memorySlot()
    const source = "https://example.test/prompt.md"
    slot.data.set(`god:prompt:v1:${source}`, JSON.stringify({ text: "  ", fetchedAt: Date.now() }))

    const loader = createLoader(await tempRoot(), {
      storage: slot,
      fetchImpl: remoteFetch(() => new Response("fresh")),
    })

    expect((await loader.load(source)).text).toBe("fresh")
  })

  test("does not touch storage when caching is disabled", async () => {
    const slot = memorySlot()
    const source = "https://example.test/prompt.md"
    slot.data.set(`god:prompt:v1:${source}`, JSON.stringify({ text: "stored", fetchedAt: Date.now() }))

    const loader = createLoader(await tempRoot(), {
      cache: false,
      storage: slot,
      fetchImpl: remoteFetch(() => new Response("live")),
    })

    expect((await loader.load(source)).text).toBe("live")
    expect(JSON.parse(slot.data.get(`god:prompt:v1:${source}`) ?? "{}").text).toBe("stored")
  })

  test("survives a storage that rejects", async () => {
    const slot = {
      get: async () => {
        throw new Error("storage offline")
      },
      set: async () => {
        throw new Error("storage offline")
      },
    }

    const loader = createLoader(await tempRoot(), {
      storage: slot,
      fetchImpl: remoteFetch(() => new Response("fresh")),
    })

    expect((await loader.load("https://example.test/prompt.md")).text).toBe("fresh")
  })
})
