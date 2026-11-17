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

function createHarness(options: Record<string, unknown> = {}, directory = process.cwd()) {
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

  test("does not match provider-prefixed mapping keys", async () => {
    const root = await tempRoot()
    await writeFile(path.join(root, "prompt.md"), "PREFIXED")
    const harness = createHarness({ models: { "provider-a/model-a": "prompt.md" } }, root)
    await setupGodAgent(harness.context)

    const system = await harness.run({ model: { providerID: "provider-a", id: "model-a" } })

    expect(system).toEqual([text("base")])
  })

  test("does not replace the system prompt for other agents", async () => {
    const root = await tempRoot()
    await writeFile(path.join(root, "prompt.md"), "GOD PROMPT")
    const harness = createHarness({ models: { "model-a": "prompt.md" } }, root)
    await setupGodAgent(harness.context)

    const system = await harness.run({ agent: "build" })

    expect(system).toEqual([text("base")])
  })

  test("leaves god unchanged when the model has no mapping", async () => {
    const root = await tempRoot()
    const harness = createHarness({ models: { "other-model": "prompt.md" } }, root)
    await setupGodAgent(harness.context)

    const system = await harness.run({ model: { providerID: "provider-a", id: "model-a" } })

    expect(system).toEqual([text("base")])
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

  test("leaves the system prompt unchanged when loading fails", async () => {
    const root = await tempRoot()
    const warnings: string[] = []
    const harness = createHarness({ models: { "model-a": "missing.md" } }, root)
    await setupGodAgent(harness.context, { log: (message) => warnings.push(message) })

    const system = await harness.run()

    expect(system).toEqual([text("base")])
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain("unable to load")
  })

  test("leaves the system prompt unchanged when the source is empty", async () => {
    const root = await tempRoot()
    await writeFile(path.join(root, "empty.md"), "")
    const warnings: string[] = []
    const harness = createHarness({ models: { "model-a": "empty.md" } }, root)
    await setupGodAgent(harness.context, { log: (message) => warnings.push(message) })

    const system = await harness.run()

    expect(system).toEqual([text("base")])
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain("empty")
  })
})
