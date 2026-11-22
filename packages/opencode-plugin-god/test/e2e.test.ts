import { expect, setDefaultTimeout, test } from "bun:test"
import { createOpenCodeE2E, type OpenCodeE2E } from "../../opencode-plugin-unicorn/test/e2e-utils.js"
import { api, prompt } from "../../opencode-plugin-show-img/test/e2e-utils.js"

setDefaultTimeout(180_000)

const DEEPSEEK = "/DeepSeek/deepseek v3.md"
const FALLBACK = "/Stealth Models/Unified.md"
const MOONSHOT = "/Moonshot AI/kimi-k2.md"
const MODELS = ["deepseek-v3", "brand-new-model", "kimi-k2"]

function session(e2e: OpenCodeE2E, title: string, agent: string, id: string) {
  return api<{ data: { id: string } }>(e2e, "/api/session", {
    title,
    agent,
    model: { providerID: "openai", id },
    location: { directory: e2e.workspace },
  }).then((response) => response.data.id)
}

function requestFor(e2e: OpenCodeE2E, marker: string) {
  return e2e.proxy.requests.find((request) => JSON.stringify(request.messages).includes(marker))
}

test("god resolves built-in prompts, caches them, and recovers from a missing file", async () => {
  const hits: string[] = []
  const bodies: Record<string, string> = {
    [DEEPSEEK]: "BUILT_IN_DEEPSEEK_PROMPT",
    [FALLBACK]: "BUILT_IN_FALLBACK_PROMPT",
  }
  const prompts = Bun.serve({
    port: 0,
    fetch(request) {
      const pathname = decodeURIComponent(new URL(request.url).pathname)
      hits.push(pathname)
      const body = bodies[pathname]
      return body ? new Response(body) : new Response("missing", { status: 404 })
    },
  })

  try {
    const e2e = await createOpenCodeE2E({
      plugin: "unicorn",
      pluginPackage: import.meta.dir + "/../../opencode-plugin-unicorn",
      pluginOptions: {
        features: {
          recommendedOpencodeConfig: false,
          sendMessageAcrossSessions: false,
          imageGen: false,
          notepad: false,
          showImg: false,
          promptSearch: false,
          sessionSearch: false,
          sensitiveEncrypt: false,
          sensitiveProtection: false,
          nonBlocking: false,
          opencodeGoUsage: false,
          god: true,
        },
        god: { sourceBaseUrl: `http://127.0.0.1:${prompts.port}/` },
      },
      configure(config) {
        for (const id of MODELS) config.providers.openai.models[id] = { ...config.providers.openai.models["gpt-5.6-luna"] }
      },
    })

    try {
      // A built-in table entry applies with no `models` option at all.
      const deepseek = await session(e2e, "God built-in", "god", "deepseek-v3")
      e2e.proxy.mock.prependFixture({ match: { userMessage: "E2E_GOD_BUILTIN", sequenceIndex: 0 }, response: { content: "OK" } })
      await prompt(e2e, deepseek, "E2E_GOD_BUILTIN")
      expect(JSON.stringify(requestFor(e2e, "E2E_GOD_BUILTIN")?.messages)).toContain("BUILT_IN_DEEPSEEK_PROMPT")

      // The second turn is served from the in-process cache, so the source is fetched once.
      e2e.proxy.mock.prependFixture({ match: { userMessage: "E2E_GOD_BUILTIN_AGAIN", sequenceIndex: 0 }, response: { content: "OK" } })
      await prompt(e2e, deepseek, "E2E_GOD_BUILTIN_AGAIN")
      expect(JSON.stringify(requestFor(e2e, "E2E_GOD_BUILTIN_AGAIN")?.messages)).toContain("BUILT_IN_DEEPSEEK_PROMPT")
      expect(hits.filter((hit) => hit === DEEPSEEK)).toHaveLength(1)

      // An unknown model id uses the wildcard fallback instead of failing.
      const unknown = await session(e2e, "God fallback", "god", "brand-new-model")
      e2e.proxy.mock.prependFixture({ match: { userMessage: "E2E_GOD_FALLBACK", sequenceIndex: 0 }, response: { content: "OK" } })
      await prompt(e2e, unknown, "E2E_GOD_FALLBACK")
      expect(JSON.stringify(requestFor(e2e, "E2E_GOD_FALLBACK")?.messages)).toContain("BUILT_IN_FALLBACK_PROMPT")

      // Other agents keep their own system prompt.
      const normal = await session(e2e, "Normal agent", "compaction-e2e", "deepseek-v3")
      e2e.proxy.mock.prependFixture({ match: { userMessage: "E2E_GOD_NORMAL", sequenceIndex: 0 }, response: { content: "OK" } })
      await prompt(e2e, normal, "E2E_GOD_NORMAL")
      expect(JSON.stringify(requestFor(e2e, "E2E_GOD_NORMAL")?.messages)).not.toContain("BUILT_IN_DEEPSEEK_PROMPT")

      // The stored prompt survives a server restart without another fetch.
      await e2e.restart()
      const restarted = await session(e2e, "God after restart", "god", "deepseek-v3")
      e2e.proxy.mock.prependFixture({ match: { userMessage: "E2E_GOD_RESTART", sequenceIndex: 0 }, response: { content: "OK" } })
      await prompt(e2e, restarted, "E2E_GOD_RESTART")
      expect(JSON.stringify(requestFor(e2e, "E2E_GOD_RESTART")?.messages)).toContain("BUILT_IN_DEEPSEEK_PROMPT")
      expect(hits.filter((hit) => hit === DEEPSEEK)).toHaveLength(1)

      // A missing built-in file degrades to the shared prompt, and the failure is
      // not retried on the next request.
      const missing = await session(e2e, "God missing file", "god", "kimi-k2")
      e2e.proxy.mock.prependFixture({ match: { userMessage: "E2E_GOD_MISSING_1", sequenceIndex: 0 }, response: { content: "OK" } })
      await prompt(e2e, missing, "E2E_GOD_MISSING_1")
      expect(JSON.stringify(requestFor(e2e, "E2E_GOD_MISSING_1")?.messages)).toContain("BUILT_IN_FALLBACK_PROMPT")

      e2e.proxy.mock.prependFixture({ match: { userMessage: "E2E_GOD_MISSING_2", sequenceIndex: 0 }, response: { content: "OK" } })
      await prompt(e2e, missing, "E2E_GOD_MISSING_2")
      expect(JSON.stringify(requestFor(e2e, "E2E_GOD_MISSING_2")?.messages)).toContain("BUILT_IN_FALLBACK_PROMPT")
      expect(hits.filter((hit) => hit === MOONSHOT)).toHaveLength(1)
    } finally {
      await e2e.close()
    }
  } finally {
    prompts.stop(true)
  }
})

test("god works standalone with the built-in table", async () => {
  const hits: string[] = []
  const prompts = Bun.serve({
    port: 0,
    fetch(request) {
      hits.push(decodeURIComponent(new URL(request.url).pathname))
      return new Response("STANDALONE_DEEPSEEK_PROMPT")
    },
  })

  try {
    const e2e = await createOpenCodeE2E({
      plugin: "unicorn",
      pluginPackage: import.meta.dir + "/..",
      pluginOptions: { sourceBaseUrl: `http://127.0.0.1:${prompts.port}/` },
      configure(config) {
        config.providers.openai.models["deepseek-v3"] = { ...config.providers.openai.models["gpt-5.6-luna"] }
      },
    })

    try {
      const id = await session(e2e, "God standalone", "god", "deepseek-v3")
      e2e.proxy.mock.prependFixture({ match: { userMessage: "E2E_GOD_STANDALONE", sequenceIndex: 0 }, response: { content: "OK" } })
      await prompt(e2e, id, "E2E_GOD_STANDALONE")
      expect(JSON.stringify(requestFor(e2e, "E2E_GOD_STANDALONE")?.messages)).toContain("STANDALONE_DEEPSEEK_PROMPT")
      expect(hits).toEqual([DEEPSEEK])
    } finally {
      await e2e.close()
    }
  } finally {
    prompts.stop(true)
  }
})
