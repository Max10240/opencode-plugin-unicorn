import { afterAll, describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { setupGodAgent, type GodPluginContext } from "../src/setup.js"

type FakeAgent = {
  id: string
  name: string
  description?: string
  mode: "subagent" | "primary" | "all"
  hidden: boolean
  permissions: Array<{ action: string; resource: string; effect: string }>
  request: { settings: Record<string, unknown>; headers: Record<string, unknown>; body: Record<string, unknown> }
}

type ContextInput = {
  sessionID: string
  agent: string
  model: { providerID: string; id: string }
  system: Array<{ type: "text"; text: string }>
  messages: unknown[]
  options: Record<string, unknown>
  tools: Record<string, unknown>
}

const roots: string[] = []

async function tempRoot() {
  const root = await mkdtemp(path.join(tmpdir(), "god-agent-"))
  roots.push(root)
  return root
}

afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })))
})

function createHarness(options: Record<string, unknown> = {}, directory = process.cwd(), storage?: GodPluginContext["storage"]) {
  const agents = new Map<string, FakeAgent>()
  const hooks = new Map<string, (input: ContextInput) => Promise<void> | void>()
  const disposed: string[] = []

  const editor = {
    list: () => [...agents.values()],
    get: (id: string) => agents.get(id),
    default: (_id: string | undefined) => {},
    update: (id: string, update: (agent: FakeAgent) => void) => {
      let agent = agents.get(id)
      if (!agent) {
        agent = {
          id,
          name: id,
          mode: "primary",
          hidden: false,
          permissions: [],
          request: { settings: {}, headers: {}, body: {} },
        }
        agents.set(id, agent)
      }
      update(agent)
      agent.id = id
    },
    remove: (id: string) => {
      agents.delete(id)
    },
  }

  const context = {
    options,
    location: { directory },
    ...(storage === undefined ? {} : { storage }),
    agent: {
      transform: async (callback: (value: typeof editor) => void) => {
        callback(editor)
        return {
          dispose: async () => {
            disposed.push("agent")
          },
        }
      },
    },
    session: {
      hook: async (name: string, callback: (input: ContextInput) => Promise<void> | void) => {
        hooks.set(name, callback)
        return {
          dispose: async () => {
            disposed.push("hook")
            hooks.delete(name)
          },
        }
      },
    },
  } as unknown as GodPluginContext

  const run = async (input: Partial<ContextInput> = {}) => {
    const hook = hooks.get("context")
    if (!hook) throw new Error("context hook not registered")
    const system = input.system ?? [{ type: "text", text: "base" }]
    await hook({
      sessionID: "session",
      agent: input.agent ?? "god",
      model: input.model ?? { providerID: "provider-a", id: "model-a" },
      system,
      messages: [],
      options: {},
      tools: {},
    })
    return system
  }

  return { agents, context, disposed, hooks, run }
}

function text(value: string) {
  return { type: "text" as const, text: value }
}

describe("setupGodAgent registration", () => {
  test("registers the god agent as a primary agent", async () => {
    const harness = createHarness()
    await setupGodAgent(harness.context)

    const god = harness.agents.get("god")
    expect(god).toBeDefined()
    expect(god?.mode).toBe("primary")
    expect(god?.description).toBeTruthy()
  })

  test("does not overwrite an existing god agent", async () => {
    const harness = createHarness()
    harness.agents.set("god", {
      id: "god",
      name: "god",
      description: "custom description",
      mode: "subagent",
      hidden: false,
      permissions: [],
      request: { settings: {}, headers: {}, body: {} },
    })

    await setupGodAgent(harness.context)

    const god = harness.agents.get("god")
    expect(god?.mode).toBe("subagent")
    expect(god?.description).toBe("custom description")
  })

  test("registers the god agent without a location", async () => {
    const harness = createHarness()
    const context = { ...harness.context, location: undefined } as GodPluginContext
    await setupGodAgent(context)

    expect(harness.agents.get("god")).toBeDefined()
  })

  test("registers only the context hook", async () => {
    const harness = createHarness()
    await setupGodAgent(harness.context)
    expect([...harness.hooks.keys()]).toEqual(["context"])
  })

  test("cleanup disposes the hook and the agent registration", async () => {
    const harness = createHarness()
    const dispose = await setupGodAgent(harness.context)

    await dispose()

    expect(harness.disposed).toEqual(["hook", "agent"])
    expect(harness.hooks.has("context")).toBe(false)
  })
})

describe("setupGodAgent system prompt replacement", () => {
  test("replaces the full system prompt for god and a matching model", async () => {
    const root = await tempRoot()
    await writeFile(path.join(root, "prompt.md"), "GOD PROMPT")
    const harness = createHarness({ models: { "model-a": "prompt.md" } }, root)
    await setupGodAgent(harness.context)

    const system = await harness.run({
      system: [text("base one"), text("base two")],
    })

    expect(system).toEqual([text("GOD PROMPT")])
  })

  test("matches by model id only, not by provider", async () => {
    const root = await tempRoot()
    await writeFile(path.join(root, "prompt.md"), "SHARED PROMPT")
    const harness = createHarness({ models: { "model-a": "prompt.md" } }, root)
    await setupGodAgent(harness.context)

    const first = await harness.run({ model: { providerID: "provider-a", id: "model-a" } })
    const second = await harness.run({ model: { providerID: "provider-b", id: "model-a" } })

    expect(first).toEqual([text("SHARED PROMPT")])
    expect(second).toEqual([text("SHARED PROMPT")])
  })

  test("matches a provider-qualified user key for that provider only", async () => {
    const root = await tempRoot()
    await writeFile(path.join(root, "prompt.md"), "SCOPED")
    await writeFile(path.join(root, "fallback.md"), "FALLBACK")
    const harness = createHarness({ models: { "provider-a/model-a": "prompt.md", "*": "fallback.md" } }, root)
    await setupGodAgent(harness.context)

    expect(await harness.run({ model: { providerID: "provider-a", id: "model-a" } })).toEqual([text("SCOPED")])
    expect(await harness.run({ model: { providerID: "provider-b", id: "model-a" } })).toEqual([text("FALLBACK")])
  })

  test("does not replace the system prompt for other agents", async () => {
    const root = await tempRoot()
    await writeFile(path.join(root, "prompt.md"), "GOD PROMPT")
    const harness = createHarness({ models: { "model-a": "prompt.md" } }, root)
    await setupGodAgent(harness.context)

    const system = await harness.run({ agent: "build" })

    expect(system).toEqual([text("base")])
  })

  test("does not fail for other agents without a mapping", async () => {
    const harness = createHarness({ models: {} })
    await setupGodAgent(harness.context)

    const system = await harness.run({ agent: "build", model: { providerID: "provider-a", id: "unmapped-model" } })

    expect(system).toEqual([text("base")])
  })

  test("keeps the default system prompt when no source can be loaded", async () => {
    const root = await tempRoot()
    const harness = createHarness({ sourceBaseUrl: "http://127.0.0.1:1/" }, root)
    await setupGodAgent(harness.context)

    const system = await harness.run({ model: { providerID: "provider-a", id: "model-without-a-source" } })

    expect(system).toEqual([text("base")])
  })

  test("uses the built-in table without a models option", async () => {
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        const pathname = decodeURIComponent(new URL(request.url).pathname)
        return pathname === "/DeepSeek/deepseek v3.md"
          ? new Response("BUILT-IN DEEPSEEK")
          : new Response("missing", { status: 404 })
      },
    })

    try {
      const harness = createHarness({ sourceBaseUrl: `http://127.0.0.1:${server.port}/` })
      await setupGodAgent(harness.context)

      const system = await harness.run({ model: { providerID: "openai", id: "deepseek-v3" } })

      expect(system).toEqual([text("BUILT-IN DEEPSEEK")])
    } finally {
      server.stop(true)
    }
  })

  test("falls back to the shared prompt when a built-in entry is missing", async () => {
    const hits: string[] = []
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        const pathname = decodeURIComponent(new URL(request.url).pathname)
        hits.push(pathname)
        return pathname === "/Stealth Models/Unified.md"
          ? new Response("SHARED FALLBACK")
          : new Response("missing", { status: 404 })
      },
    })

    try {
      const harness = createHarness({ sourceBaseUrl: `http://127.0.0.1:${server.port}/` })
      await setupGodAgent(harness.context)

      expect(await harness.run({ model: { providerID: "openai", id: "deepseek-v3" } })).toEqual([text("SHARED FALLBACK")])
      expect(await harness.run({ model: { providerID: "openai", id: "deepseek-v3" } })).toEqual([text("SHARED FALLBACK")])
      // One attempt for the missing file, one fetch of the shared prompt.
      expect(hits).toEqual(["/DeepSeek/deepseek v3.md", "/Stealth Models/Unified.md"])
    } finally {
      server.stop(true)
    }
  })

  test("reuses a stored prompt without fetching again", async () => {
    let requests = 0
    const server = Bun.serve({
      port: 0,
      fetch() {
        requests += 1
        return new Response("REMOTE")
      },
    })
    const data = new Map<string, string>()
    const storage = {
      get: async (key: string) => data.get(key),
      set: async (key: string, value: string) => {
        data.set(key, value)
      },
    }

    try {
      const source = `http://127.0.0.1:${server.port}/prompt.md`

      const first = createHarness({ models: { "model-a": source } }, process.cwd(), storage)
      await setupGodAgent(first.context)
      expect(await first.run()).toEqual([text("REMOTE")])
      expect(requests).toBe(1)

      const second = createHarness({ models: { "model-a": source } }, process.cwd(), storage)
      await setupGodAgent(second.context)
      expect(await second.run()).toEqual([text("REMOTE")])
      expect(requests).toBe(1)
    } finally {
      server.stop(true)
    }
  })

  test("uses the wildcard mapping as a fallback", async () => {
    const root = await tempRoot()
    await writeFile(path.join(root, "default.md"), "DEFAULT PROMPT")
    const harness = createHarness({ models: { "*": "default.md" } }, root)
    await setupGodAgent(harness.context)

    const system = await harness.run({ model: { providerID: "provider-a", id: "unknown-model" } })

    expect(system).toEqual([text("DEFAULT PROMPT")])
  })

  test("prefers an exact mapping over the wildcard", async () => {
    const root = await tempRoot()
    await writeFile(path.join(root, "default.md"), "DEFAULT PROMPT")
    await writeFile(path.join(root, "exact.md"), "EXACT PROMPT")
    const harness = createHarness({ models: { "*": "default.md", "model-a": "exact.md" } }, root)
    await setupGodAgent(harness.context)

    const system = await harness.run({ model: { providerID: "provider-a", id: "model-a" } })

    expect(system).toEqual([text("EXACT PROMPT")])
  })

  test("loads a prompt over HTTP", async () => {
    const server = Bun.serve({
      port: 0,
      fetch() {
        return new Response("REMOTE PROMPT")
      },
    })

    try {
      const source = `http://127.0.0.1:${server.port}/prompt.md`
      const harness = createHarness({ models: { "model-a": source } })
      await setupGodAgent(harness.context)

      const system = await harness.run()

      expect(system).toEqual([text("REMOTE PROMPT")])
    } finally {
      server.stop(true)
    }
  })

  test("keeps the default system prompt when loading fails", async () => {
    const root = await tempRoot()
    const harness = createHarness({ models: { "model-a": "missing.md" } }, root)
    await setupGodAgent(harness.context)

    const system = await harness.run()

    expect(system).toEqual([text("base")])
  })

  test("keeps the default system prompt when the source is empty", async () => {
    const root = await tempRoot()
    await writeFile(path.join(root, "empty.md"), "")
    const harness = createHarness({ models: { "model-a": "empty.md" } }, root)
    await setupGodAgent(harness.context)

    const system = await harness.run()

    expect(system).toEqual([text("base")])
  })

  test("fills an empty system prompt list", async () => {
    const root = await tempRoot()
    await writeFile(path.join(root, "prompt.md"), "GOD PROMPT")
    const harness = createHarness({ models: { "model-a": "prompt.md" } }, root)
    await setupGodAgent(harness.context)

    expect(await harness.run({ system: [] })).toEqual([text("GOD PROMPT")])
  })

  test("keeps the default system prompt when the remote body is blank", async () => {
    const server = Bun.serve({
      port: 0,
      fetch() {
        return new Response("   \n")
      },
    })

    try {
      const harness = createHarness({ models: { "model-a": `http://127.0.0.1:${server.port}/blank.md` } })
      await setupGodAgent(harness.context)

      expect(await harness.run()).toEqual([text("base")])
    } finally {
      server.stop(true)
    }
  })

  test("keeps the default system prompt for an invalid source base", async () => {
    const harness = createHarness({ sourceBaseUrl: "not a url" })
    await setupGodAgent(harness.context)

    expect(await harness.run({ model: { providerID: "openai", id: "deepseek-v3" } })).toEqual([text("base")])
  })

  test("warns once per source when loading keeps failing", async () => {
    const warnings: string[] = []
    const original = console.warn
    console.warn = (...args: unknown[]) => {
      warnings.push(args.join(" "))
    }

    try {
      const root = await tempRoot()
      const harness = createHarness({ models: { "model-a": "missing.md" } }, root)
      await setupGodAgent(harness.context)

      await harness.run()
      await harness.run()
      await harness.run()

      expect(warnings).toHaveLength(1)
    } finally {
      console.warn = original
    }
  })
})
