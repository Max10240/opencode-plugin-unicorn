import { expect, setDefaultTimeout, test } from "bun:test"
import path from "node:path"
import { createOpenCodeE2E } from "../../opencode-plugin-unicorn/test/e2e-utils.js"
import { api, createSession, prompt, waitFor } from "../../opencode-plugin-show-img/test/e2e-utils.js"
import { DEFAULT_MESSAGE } from "../src/options.js"

setDefaultTimeout(180_000)

const RPC = "max10240.dead-loop"
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
  nudging?: boolean
  outcome?: { reason: string; at: number }
}

/** Each nudge turn ends in an assistant NUDGE_ACK reply, which the export does surface. */
async function ackCount(e2e: E2E, sessionID: string): Promise<number> {
  const exported = await api<{ data: { messages: Array<Record<string, any>> } }>(e2e, `/api/experimental/session/${sessionID}/export`)
  return exported.data.messages
    .flatMap((message) => message.content ?? [])
    .filter((part) => part.type === "text" && part.text === "NUDGE_ACK")
    .length
}

const DEAD_LOOP_OPTIONS = { delayMs: 400, recheckMs: 1_000, minDurationMs: 1_000, maxDurationMs: 60_000 }

async function runLoopScenario(mode: "standalone" | "unicorn") {
  const e2e = await createOpenCodeE2E(
    mode === "standalone"
      ? {
          plugin: "unicorn",
          pluginPackage: PACKAGE_ROOT,
          pluginOptions: { ...DEAD_LOOP_OPTIONS },
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
              deadLoop: true,
            },
            deadLoop: { ...DEAD_LOOP_OPTIONS },
          },
        },
  )
  try {
    e2e.proxy.mock.prependFixture({
      match: { userMessage: "E2E_DEADLOOP_BEGIN", sequenceIndex: 0 },
      response: { content: "E2E_BEGIN_OK" },
    })
    e2e.proxy.mock.prependFixture({
      match: { userMessage: DEFAULT_MESSAGE },
      response: { content: "NUDGE_ACK" },
    })

    const sessionID = await createSession(e2e, `Dead-Loop-E2E-${mode}`)
    await prompt(e2e, sessionID, "E2E_DEADLOOP_BEGIN")

    // Before activation the session idles quietly.
    await Bun.sleep(1_500)
    expect((await rpcCall<Status>(e2e, "status", { sessionID })).active).toBe(false)
    expect(await ackCount(e2e, sessionID)).toBe(0)

    const started = await rpcCall<Status>(e2e, "start", { sessionID, durationMs: 20_000 })
    expect(started.active).toBe(true)
    expect(started.deadline).toBeDefined()

    // The quiet window elapses on an idle session and the nudge lands as a user message.
    await waitFor(
      async () => ((await rpcCall<Status>(e2e, "status", { sessionID })).sentCount ?? 0) >= 1,
      "the first nudge never arrived",
      20_000,
    )
    // The nudge turn runs right after the nudge; its assistant reply lands shortly.
    await waitFor(async () => (await ackCount(e2e, sessionID)) >= 1, "the first nudge turn never completed", 15_000)

    // The loop repeats after each nudge turn completes.
    await waitFor(async () => {
      const status = await rpcCall<Status>(e2e, "status", { sessionID })
      return (status.sentCount ?? 0) >= 2
    }, "the loop did not repeat", 30_000)

    // Stop while the quiet window is pending so no send can be in flight.
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

    // After the stop, no further nudges appear.
    await Bun.sleep(2_500)
    expect(await ackCount(e2e, sessionID)).toBe(acksAtStop)
    expect((await rpcCall<Status>(e2e, "status", { sessionID })).sentCount).toBe(stopped.sentCount)
  } finally {
    await e2e.close()
  }
}

for (const mode of ["standalone", "unicorn"] as const) {
  test(`dead loop nudges an idle session and stops on request (${mode})`, async () => {
    await runLoopScenario(mode)
  })
}

test("dead loop expires at the configured deadline", async () => {
  const e2e = await createOpenCodeE2E({
    plugin: "unicorn",
    pluginPackage: PACKAGE_ROOT,
    pluginOptions: { ...DEAD_LOOP_OPTIONS, delayMs: 300 },
  })
  try {
    e2e.proxy.mock.prependFixture({
      match: { userMessage: DEFAULT_MESSAGE },
      response: { content: "NUDGE_ACK" },
    })
    const sessionID = await createSession(e2e, "Dead-Loop-E2E-Expiry")
    await prompt(e2e, sessionID, "E2E_DEADLOOP_BEGIN")

    const started = await rpcCall<Status>(e2e, "start", { sessionID, durationMs: 1_500 })
    expect(started.active).toBe(true)

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
