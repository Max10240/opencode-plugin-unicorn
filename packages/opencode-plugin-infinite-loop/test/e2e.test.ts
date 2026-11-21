import { expect, setDefaultTimeout, test } from "bun:test"
import path from "node:path"
import { createOpenCodeE2E } from "../../opencode-plugin-unicorn/test/e2e-utils.js"
import { api, createSession, prompt, waitFor } from "../../opencode-plugin-show-img/test/e2e-utils.js"
import { DEFAULT_MESSAGE } from "../src/options.js"

setDefaultTimeout(180_000)

const RPC = "max10240.infinite-loop"
const PACKAGE_ROOT = path.resolve(import.meta.dir, "..")
const UNICORN_ROOT = path.resolve(import.meta.dir, "../../opencode-plugin-unicorn")

type E2E = Awaited<ReturnType<typeof createOpenCodeE2E>>

function locationQuery(e2e: E2E) {
  return `?location[directory]=${encodeURIComponent(e2e.workspace)}`
}

async function rpcCall<T>(e2e: E2E, method: string, input: unknown): Promise<T> {
  const response = await api<{ output?: T }>(e2e, `/api/rpc/${RPC}/${method}${locationQuery(e2e)}`, { input })
  return response.output as T
}

type Status = {
  active: boolean
  startedAt?: number
  deadline?: number
  sentCount?: number
  lastSentAt?: number
  cooldownMs?: number
  cooldownUntil?: number
  nextNudgeAt?: number
  phase?: string
  nudging?: boolean
  outcome?: { reason: string; at: number }
}

async function ackCount(e2e: E2E, sessionID: string): Promise<number> {
  const exported = await api<{ data: { messages: Array<Record<string, any>> } }>(e2e, `/api/experimental/session/${sessionID}/export`)
  return exported.data.messages
    .flatMap((message) => message.content ?? [])
    .filter((part) => part.type === "text" && part.text === "NUDGE_ACK")
    .length
}

const LOOP_OPTIONS = { delayMs: 300, recheckMs: 500, cooldownMs: 1_000, minDurationMs: 1_000, maxDurationMs: 60_000 }

async function runLoopScenario(mode: "standalone" | "unicorn") {
  const e2e = await createOpenCodeE2E(
    mode === "standalone"
      ? {
          plugin: "unicorn",
          pluginPackage: PACKAGE_ROOT,
          pluginOptions: { ...LOOP_OPTIONS },
        }
      : {
          plugin: "unicorn",
          pluginPackage: UNICORN_ROOT,
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
              infiniteLoop: true,
            },
            infiniteLoop: { ...LOOP_OPTIONS },
          },
        },
  )
  try {
    e2e.proxy.mock.prependFixture({
      match: { userMessage: "E2E_INFINITELOOP_BEGIN", sequenceIndex: 0 },
      response: { content: "E2E_BEGIN_OK" },
    })
    e2e.proxy.mock.prependFixture({
      match: { userMessage: DEFAULT_MESSAGE },
      response: { content: "NUDGE_ACK" },
    })

    const sessionID = await createSession(e2e, `Infinite-Loop-E2E-${mode}`)
    await prompt(e2e, sessionID, "E2E_INFINITELOOP_BEGIN")

    await Bun.sleep(1_500)
    expect((await rpcCall<Status>(e2e, "status", { sessionID })).active).toBe(false)
    expect(await ackCount(e2e, sessionID)).toBe(0)

    const started = await rpcCall<Status>(e2e, "start", { sessionID, durationMs: 20_000 })
    expect(started.active).toBe(true)
    expect(started.deadline).toBeDefined()
    expect(started.cooldownMs).toBe(1_000)

    await waitFor(
      async () => ((await rpcCall<Status>(e2e, "status", { sessionID })).sentCount ?? 0) >= 1,
      "the first nudge never arrived",
      20_000,
    )
    await waitFor(async () => (await ackCount(e2e, sessionID)) >= 1, "the first nudge turn never completed", 15_000)

    await waitFor(async () => {
      const status = await rpcCall<Status>(e2e, "status", { sessionID })
      return (status.sentCount ?? 0) >= 2
    }, "the loop did not repeat", 30_000)

    await waitFor(
      async () => (await rpcCall<Status>(e2e, "status", { sessionID })).nudging === true,
      "the quiet window never armed",
      15_000,
    )
    const stopped = await rpcCall<Status>(e2e, "stop", { sessionID })
    expect(stopped.active).toBe(false)
    expect(stopped.outcome?.reason).toBe("stopped")
    expect(stopped.sentCount ?? 0).toBeGreaterThanOrEqual(2)
    const acksAtStop = await ackCount(e2e, sessionID)

    await Bun.sleep(2_500)
    expect(await ackCount(e2e, sessionID)).toBe(acksAtStop)
    expect((await rpcCall<Status>(e2e, "status", { sessionID })).sentCount).toBe(stopped.sentCount)
  } finally {
    await e2e.close()
  }
}

for (const mode of ["standalone", "unicorn"] as const) {
  test(`infinite loop nudges an idle session and stops on request (${mode})`, async () => {
    await runLoopScenario(mode)
  })
}

test("cooldown waits from the last nudge and keeps the exact remaining time", async () => {
  const e2e = await createOpenCodeE2E({
    plugin: "unicorn",
    pluginPackage: PACKAGE_ROOT,
    pluginOptions: { ...LOOP_OPTIONS, cooldownMs: 2_000 },
  })
  try {
    e2e.proxy.mock.prependFixture({
      match: { userMessage: "E2E_COOLDOWN_BEGIN", sequenceIndex: 0 },
      response: { content: "E2E_BEGIN_OK" },
    })
    e2e.proxy.mock.prependFixture({
      match: { userMessage: DEFAULT_MESSAGE },
      response: { content: "NUDGE_ACK" },
    })
    const sessionID = await createSession(e2e, "Infinite-Loop-E2E-Cooldown")
    await prompt(e2e, sessionID, "E2E_COOLDOWN_BEGIN")
    await rpcCall<Status>(e2e, "start", { sessionID, durationMs: 30_000 })

    await waitFor(
      async () => ((await rpcCall<Status>(e2e, "status", { sessionID })).sentCount ?? 0) >= 1,
      "the first nudge never arrived",
      20_000,
    )
    const first = await rpcCall<Status>(e2e, "status", { sessionID })
    expect(first.lastSentAt).toBeDefined()

    await Bun.sleep(500)
    expect((await rpcCall<Status>(e2e, "status", { sessionID })).sentCount).toBe(1)

    await waitFor(
      async () => ((await rpcCall<Status>(e2e, "status", { sessionID })).sentCount ?? 0) >= 2,
      "the second nudge never arrived",
      20_000,
    )
    const second = await rpcCall<Status>(e2e, "status", { sessionID })
    expect(second.lastSentAt! - first.lastSentAt!).toBeGreaterThanOrEqual(1_900)
    expect(second.lastSentAt! - first.lastSentAt!).toBeLessThanOrEqual(4_000)
  } finally {
    await e2e.close()
  }
})

test("a running background shell holds the nudge until it exits", async () => {
  const e2e = await createOpenCodeE2E({
    plugin: "unicorn",
    pluginPackage: PACKAGE_ROOT,
    pluginOptions: { ...LOOP_OPTIONS, cooldownMs: 0 },
  })
  try {
    const toolID = `call_${crypto.randomUUID()}`
    // prependFixture unshifts: the last registered fixture is matched first. Register the
    // broad fallback first and the one-shot overrides last.
    e2e.proxy.mock.prependFixture({ match: { userMessage: DEFAULT_MESSAGE }, response: { content: "NUDGE_ACK" } })
    e2e.proxy.mock.prependFixture({ match: { toolCallId: toolID }, response: { content: "BACKGROUND_STARTED" } })
    e2e.proxy.mock.prependFixture({
      match: { userMessage: DEFAULT_MESSAGE, sequenceIndex: 0 },
      response: {
        toolCalls: [{
          id: toolID,
          name: "shell",
          arguments: JSON.stringify({ command: "sleep 3", background: true }),
        }],
      },
    })
    e2e.proxy.mock.prependFixture({
      match: { userMessage: "E2E_SHELL_BEGIN", sequenceIndex: 0 },
      response: { content: "E2E_BEGIN_OK" },
    })

    const sessionID = await createSession(e2e, "Infinite-Loop-E2E-Shell")
    await prompt(e2e, sessionID, "E2E_SHELL_BEGIN")
    await rpcCall<Status>(e2e, "start", { sessionID, durationMs: 30_000 })

    await waitFor(
      async () => ((await rpcCall<Status>(e2e, "status", { sessionID })).sentCount ?? 0) >= 1,
      "the first nudge never arrived",
      20_000,
    )
    await Bun.sleep(1_200)
    expect((await rpcCall<Status>(e2e, "status", { sessionID })).sentCount).toBe(1)

    await waitFor(
      async () => ((await rpcCall<Status>(e2e, "status", { sessionID })).sentCount ?? 0) >= 2,
      "the loop did not resume after the background shell exited",
      40_000,
    )
  } finally {
    await e2e.close()
  }
})

test("a busy child session holds the nudge until it is idle", async () => {
  const e2e = await createOpenCodeE2E({
    plugin: "unicorn",
    pluginPackage: PACKAGE_ROOT,
    pluginOptions: { ...LOOP_OPTIONS, cooldownMs: 0 },
  })
  try {
    const toolID = `call_${crypto.randomUUID()}`
    e2e.proxy.mock.prependFixture({
      match: { userMessage: DEFAULT_MESSAGE },
      response: { content: "NUDGE_ACK" },
    })
    e2e.proxy.mock.prependFixture({
      match: { userMessage: "E2E_CHILD_PARENT", sequenceIndex: 0 },
      response: { content: "PARENT_OK" },
    })
    e2e.proxy.mock.prependFixture({ match: { toolCallId: toolID }, response: { content: "CHILD_DONE" } })
    e2e.proxy.mock.prependFixture({
      match: { userMessage: "E2E_CHILD_BUSY", sequenceIndex: 0 },
      response: {
        toolCalls: [{
          id: toolID,
          name: "shell",
          arguments: JSON.stringify({ command: "sleep 8" }),
        }],
      },
    })

    const parent = await createSession(e2e, "Infinite-Loop-E2E-Parent")
    const created = await api<{ data: { id: string } }>(e2e, "/api/session", {
      title: "Infinite-Loop-E2E-Child",
      parentID: parent,
      agent: "compaction-e2e",
      model: { providerID: "openai", id: "gpt-5.6-luna" },
      location: { directory: e2e.workspace },
    })
    const child = created.data.id
    // Start the child without waiting for it to finish: the helper `prompt` waits for idle.
    await api(e2e, `/api/session/${child}/prompt`, { text: "E2E_CHILD_BUSY", delivery: "queue" })
    await waitFor(async () => {
      const info = await api<{ data: { time?: { busy?: number; idle?: number } } }>(e2e, `/api/session/${child}`)
      return (info.data.time?.busy ?? 0) > (info.data.time?.idle ?? 0)
    }, "the child session did not start", 10_000)
    await prompt(e2e, parent, "E2E_CHILD_PARENT")

    await rpcCall<Status>(e2e, "start", { sessionID: parent, durationMs: 30_000 })
    await Bun.sleep(1_200)
    expect((await rpcCall<Status>(e2e, "status", { sessionID: parent })).sentCount ?? 0).toBe(0)

    await waitFor(
      async () => ((await rpcCall<Status>(e2e, "status", { sessionID: parent })).sentCount ?? 0) >= 1,
      "the parent was not nudged after the child went idle",
      40_000,
    )
  } finally {
    await e2e.close()
  }
})

test("a failed nudge turn recovers and keeps the loop going", async () => {
  const e2e = await createOpenCodeE2E({
    plugin: "unicorn",
    pluginPackage: PACKAGE_ROOT,
    pluginOptions: { ...LOOP_OPTIONS, cooldownMs: 0 },
  })
  try {
    e2e.proxy.mock.prependFixture({
      match: { userMessage: DEFAULT_MESSAGE },
      response: { content: "NUDGE_ACK" },
    })
    e2e.proxy.mock.prependFixture({
      match: { userMessage: DEFAULT_MESSAGE, sequenceIndex: 0 },
      response: { error: { message: "E2E_INFINITELOOP_FAILURE" }, status: 500 },
    })
    const sessionID = await createSession(e2e, "Infinite-Loop-E2E-Failure")
    await prompt(e2e, sessionID, "E2E_FAILURE_BEGIN")

    await rpcCall<Status>(e2e, "start", { sessionID, durationMs: 60_000 })
    await waitFor(
      async () => ((await rpcCall<Status>(e2e, "status", { sessionID })).sentCount ?? 0) >= 2,
      "the loop did not recover after a failed nudge turn",
      60_000,
    )
  } finally {
    await e2e.close()
  }
})

test("a manual user interruption pauses until the next normal turn", async () => {
  const e2e = await createOpenCodeE2E({
    plugin: "unicorn",
    pluginPackage: PACKAGE_ROOT,
    pluginOptions: { ...LOOP_OPTIONS, cooldownMs: 0 },
  })
  try {
    const marker = `${e2e.workspace}/infinite-loop-release.marker`
    const toolID = `call_${crypto.randomUUID()}`
    e2e.proxy.mock.prependFixture({ match: { userMessage: DEFAULT_MESSAGE }, response: { content: "NUDGE_ACK" } })
    e2e.proxy.mock.prependFixture({ match: { userMessage: "E2E_RESUME" }, response: { content: "RESUMED" } })
    e2e.proxy.mock.prependFixture({ match: { toolCallId: toolID }, response: { content: "WAITED" } })
    e2e.proxy.mock.prependFixture({
      match: { userMessage: DEFAULT_MESSAGE, sequenceIndex: 0 },
      response: {
        toolCalls: [{
          id: toolID,
          name: "shell",
          arguments: JSON.stringify({ command: `for i in $(seq 1 300); do [ -f ${JSON.stringify(marker)} ] && break; sleep 0.1; done` }),
        }],
      },
    })
    e2e.proxy.mock.prependFixture({
      match: { userMessage: "E2E_INTERRUPT_BEGIN", sequenceIndex: 0 },
      response: { content: "E2E_BEGIN_OK" },
    })

    const sessionID = await createSession(e2e, "Infinite-Loop-E2E-Interrupt")
    await prompt(e2e, sessionID, "E2E_INTERRUPT_BEGIN")
    await rpcCall<Status>(e2e, "start", { sessionID, durationMs: 60_000 })

    await waitFor(
      async () => ((await rpcCall<Status>(e2e, "status", { sessionID })).sentCount ?? 0) >= 1,
      "the first nudge never arrived",
      20_000,
    )
    await api(e2e, `/api/session/${sessionID}/interrupt`, {})
    await Bun.sleep(5_000)
    const paused = await rpcCall<Status>(e2e, "status", { sessionID })
    expect(paused.sentCount).toBe(1)
    expect(paused.active).toBe(true)
    expect(paused.phase).toBe("paused")

    await prompt(e2e, sessionID, "E2E_RESUME")
    await waitFor(
      async () => ((await rpcCall<Status>(e2e, "status", { sessionID })).sentCount ?? 0) >= 2,
      "the loop did not resume after the next normal turn",
      30_000,
    )
    await Bun.write(marker, "release")
  } finally {
    await e2e.close()
  }
})

test("infinite loop expires at the configured deadline", async () => {
  const e2e = await createOpenCodeE2E({
    plugin: "unicorn",
    pluginPackage: PACKAGE_ROOT,
    pluginOptions: { ...LOOP_OPTIONS, delayMs: 200, cooldownMs: 0 },
  })
  try {
    e2e.proxy.mock.prependFixture({
      match: { userMessage: DEFAULT_MESSAGE },
      response: { content: "NUDGE_ACK" },
    })
    const sessionID = await createSession(e2e, "Infinite-Loop-E2E-Expiry")
    await prompt(e2e, sessionID, "E2E_EXPIRY_BEGIN")

    await rpcCall<Status>(e2e, "start", { sessionID, durationMs: 1_500 })
    await waitFor(
      async () => (await rpcCall<Status>(e2e, "status", { sessionID })).outcome?.reason === "expired",
      "the task never expired",
      30_000,
    )
    const sentCount = (await rpcCall<Status>(e2e, "status", { sessionID })).sentCount ?? 0
    expect(sentCount).toBeGreaterThanOrEqual(1)

    await Bun.sleep(2_000)
    expect((await rpcCall<Status>(e2e, "status", { sessionID })).sentCount).toBe(sentCount)
  } finally {
    await e2e.close()
  }
})
