import { expect, setDefaultTimeout, test } from "bun:test"
import path from "node:path"
import { createOpenCodeE2E } from "../../opencode-plugin-unicorn/test/e2e-utils.js"
import { api, createSession, prompt, waitFor } from "../../opencode-plugin-show-img/test/e2e-utils.js"

setDefaultTimeout(180_000)

const RPC = "max10240.delayed-queue"
const PACKAGE_ROOT = path.resolve(import.meta.dir, "..")


async function createE2E(configure?: (config: Record<string, any>) => void) {
  return createOpenCodeE2E({
    plugin: "unicorn",
    pluginPackage: PACKAGE_ROOT,
    pluginOptions: { recheckMs: 1_000 },
    ...(configure === undefined ? {} : { configure }),
  })
}

function locationQuery(e2e: Awaited<ReturnType<typeof createE2E>>) {
  return `?location[directory]=${encodeURIComponent(e2e.workspace)}`
}

async function rpc<T>(e2e: Awaited<ReturnType<typeof createE2E>>, method: string, input: unknown): Promise<T> {
  const response = await api<{ output?: T }>(e2e, `/api/rpc/${RPC}/${method}${locationQuery(e2e)}`, { input })
  return response.output as T
}

type Status = {
  sessionID: string
  paused: boolean
  pauseReason?: string
  items: Array<{ id: string; text: string }>
  waitingFor: Array<{ kind: string; sessionID: string; label?: string }>
  observed: boolean
  delivering: boolean
}

async function busy(e2e: Awaited<ReturnType<typeof createE2E>>, sessionID: string) {
  const response = await api<{ data: { time?: { busy?: number; idle?: number } } }>(e2e, `/api/session/${sessionID}`)
  const time = response.data.time
  return time?.busy !== undefined && (time.idle === undefined || time.busy > time.idle)
}

async function exported(e2e: Awaited<ReturnType<typeof createE2E>>, sessionID: string) {
  return (await api<{ data: { messages: Array<Record<string, any>> } }>(e2e, `/api/experimental/session/${sessionID}/export`)).data.messages
}

async function userTexts(e2e: Awaited<ReturnType<typeof createE2E>>, sessionID: string) {
  return (await exported(e2e, sessionID))
    .filter((message) => message.type === "user")
    .flatMap((message) => {
      if (typeof message.text === "string") return [message.text]
      return Array.isArray(message.content)
        ? message.content.filter((part: Record<string, any>) => part.type === "text").map((part: any) => part.text as string)
        : []
    })
}

test("delivers a queued message when the session is idle", async () => {
  const e2e = await createE2E()
  try {
    const sessionID = await createSession(e2e, "Delayed-Queue-E2E")
    e2e.proxy.mock.prependFixture({
      match: { userMessage: "E2E_DQ_BEGIN", sequenceIndex: 0 },
      response: { content: "BEGIN_OK" },
    })
    e2e.proxy.mock.prependFixture({
      match: { userMessage: "E2E_DQ_DELIVERED", sequenceIndex: 0 },
      response: { content: "DELIVERED_OK" },
    })
    await prompt(e2e, sessionID, "E2E_DQ_BEGIN")
    await waitFor(async () => (await rpc<Status>(e2e, "status", { sessionID })).observed, "idle hook never ran")

    const status = await rpc<Status>(e2e, "enqueue", { sessionID, text: "E2E_DQ_DELIVERED" })
    expect(status.items).toHaveLength(0)
    await prompt(e2e, sessionID, "E2E_DQ_AFTER")
    await waitFor(
      async () => (await userTexts(e2e, sessionID)).includes("E2E_DQ_DELIVERED"),
      "delayed message was not delivered",
    )
  } finally {
    await e2e.close()
  }
})

test("waits for a background shell before delivering", async () => {
  const e2e = await createE2E()
  try {
    const sessionID = await createSession(e2e, "Delayed-Queue-Background")
    e2e.proxy.mock.prependFixture({
      match: { userMessage: "E2E_DQ_BG", sequenceIndex: 0 },
      response: {
        toolCalls: [
          {
            id: "call_dq_bg",
            name: "shell",
            arguments: JSON.stringify({ command: "sleep 4; echo DQ_BG_DONE", background: true }),
          },
        ],
      },
    })
    e2e.proxy.mock.prependFixture({ match: { toolCallId: "call_dq_bg" }, response: { content: "BG_STARTED" } })
    e2e.proxy.mock.prependFixture({ match: { userMessage: /DQ_BG_DONE/ }, response: { content: "BG_NOTICE_OK" } })
    e2e.proxy.mock.prependFixture({ match: { userMessage: "E2E_DQ_BG_DELIVERED" }, response: { content: "BG_DELIVERED_OK" } })

    await prompt(e2e, sessionID, "E2E_DQ_BG")
    await waitFor(async () => {
      const jobs = await api<{ data: Array<Record<string, any>> }>(e2e, `/api/experimental/job${locationQuery(e2e)}&sessionID=${sessionID}`)
      return jobs.data.some((job) => job.kind === "shell" && job.status === "running")
    }, "background shell was not registered", 15_000)

    await rpc<Status>(e2e, "enqueue", { sessionID, text: "E2E_DQ_BG_DELIVERED" })
    await Bun.sleep(500)
    expect((await userTexts(e2e, sessionID)).includes("E2E_DQ_BG_DELIVERED")).toBe(false)

    await waitFor(
      async () => (await userTexts(e2e, sessionID)).includes("E2E_DQ_BG_DELIVERED"),
      "delayed message did not wait for the background shell",
      20_000,
    )
  } finally {
    await e2e.close()
  }
})

test("pauses on a user interrupt and resumes after the next prompt", async () => {
  const e2e = await createE2E()
  try {
    const sessionID = await createSession(e2e, "Delayed-Queue-Interrupt")
    e2e.proxy.mock.prependFixture({
      match: { userMessage: "E2E_DQ_INTERRUPT", sequenceIndex: 0 },
      response: { content: "INTERRUPT_OK" },
      latency: 10_000,
    })
    e2e.proxy.mock.prependFixture({
      match: { userMessage: "E2E_DQ_RESUME", sequenceIndex: 0 },
      response: { content: "RESUME_OK" },
    })
    e2e.proxy.mock.prependFixture({
      match: { userMessage: "E2E_DQ_INTERRUPT_DELIVERED", sequenceIndex: 0 },
      response: { content: "INTERRUPT_DELIVERED_OK" },
    })

    await api(e2e, `/api/session/${sessionID}/prompt`, { text: "E2E_DQ_INTERRUPT" })
    await Bun.sleep(250)
    await rpc<Status>(e2e, "enqueue", { sessionID, text: "E2E_DQ_INTERRUPT_DELIVERED" })
    await api(e2e, `/api/session/${sessionID}/interrupt`, { resume: true })
    await waitFor(async () => (await rpc<Status>(e2e, "status", { sessionID })).paused, "queue did not pause")
    expect((await rpc<Status>(e2e, "status", { sessionID })).pauseReason).toBe("interrupted")

    await prompt(e2e, sessionID, "E2E_DQ_RESUME")
    await waitFor(
      async () => (await userTexts(e2e, sessionID)).includes("E2E_DQ_INTERRUPT_DELIVERED"),
      "delayed message did not resume after the next prompt",
      20_000,
    )
  } finally {
    await e2e.close()
  }
})

test("pauses after an execution failure and resumes after the next prompt", async () => {
  const e2e = await createE2E()
  try {
    const sessionID = await createSession(e2e, "Delayed-Queue-Failure")
    e2e.proxy.mock.prependFixture({
      match: { userMessage: "E2E_DQ_SLOW_TURN", sequenceIndex: 0 },
      response: { content: "SLOW_OK" },
      latency: 4_000,
    })
    e2e.proxy.mock.prependFixture({
      match: { userMessage: "E2E_DQ_FAIL_ONLY", sequenceIndex: 0 },
      response: { error: { message: "E2E intentional failure", type: "invalid_request_error" }, status: 400 },
    })
    e2e.proxy.mock.prependFixture({
      match: { userMessage: "E2E_DQ_RESUME_AFTER_FAIL", sequenceIndex: 0 },
      response: { content: "FAIL_RESUME_OK" },
    })
    e2e.proxy.mock.prependFixture({
      match: { userMessage: "E2E_DQ_DELIVER_AFTER_FAIL", sequenceIndex: 0 },
      response: { content: "FAIL_DELIVERED_OK" },
    })

    await api(e2e, `/api/session/${sessionID}/prompt`, { text: "E2E_DQ_SLOW_TURN" })
    await waitFor(() => busy(e2e, sessionID), "slow turn did not start")
    await rpc<Status>(e2e, "enqueue", { sessionID, text: "E2E_DQ_DELIVER_AFTER_FAIL" })
    await waitFor(async () => (await rpc<Status>(e2e, "status", { sessionID })).items.length === 1, "delayed message was not held")
    await api(e2e, `/api/session/${sessionID}/prompt`, { text: "E2E_DQ_FAIL_ONLY" })

    await waitFor(async () => {
      const status = await rpc<Status>(e2e, "status", { sessionID })
      return status.paused && status.pauseReason === "failed"
    }, "queue did not pause after failure", 20_000)

    await prompt(e2e, sessionID, "E2E_DQ_RESUME_AFTER_FAIL")
    await waitFor(
      async () => (await userTexts(e2e, sessionID)).includes("E2E_DQ_DELIVER_AFTER_FAIL"),
      "delayed message did not resume after failure",
      20_000,
    )
  } finally {
    await e2e.close()
  }
})

test("restores a queue paused after a server restart and resumes it", async () => {
  const e2e = await createE2E()
  try {
    const sessionID = await createSession(e2e, "Delayed-Queue-Restart")
    e2e.proxy.mock.prependFixture({
      match: { userMessage: "E2E_DQ_RESTART_BEGIN", sequenceIndex: 0 },
      response: { content: "RESTART_BEGIN_OK" },
    })
    e2e.proxy.mock.prependFixture({
      match: { userMessage: "E2E_DQ_RESTART_DELIVERED", sequenceIndex: 0 },
      response: { content: "RESTART_DELIVERED_OK" },
    })
    await prompt(e2e, sessionID, "E2E_DQ_RESTART_BEGIN")
    await waitFor(async () => (await rpc<Status>(e2e, "status", { sessionID })).observed, "idle hook never ran")
    await rpc<Status>(e2e, "pause", { sessionID })
    await rpc<Status>(e2e, "enqueue", { sessionID, text: "E2E_DQ_RESTART_DELIVERED" })
    expect((await rpc<Status>(e2e, "status", { sessionID })).items).toHaveLength(1)

    await e2e.restart()
    await waitFor(async () => {
      try {
        const status = await rpc<Status>(e2e, "status", { sessionID })
        return status.paused && status.pauseReason === "restart" && status.items.length === 1
      } catch {
        return false
      }
    }, "restored queue was not paused after restart", 20_000)

    await rpc<Status>(e2e, "resume", { sessionID })
    await waitFor(
      async () => (await userTexts(e2e, sessionID)).includes("E2E_DQ_RESTART_DELIVERED"),
      "restored message did not deliver after resume",
      20_000,
    )
  } finally {
    await e2e.close()
  }
})

test("waits for a real subagent before delivering", async () => {
  const e2e = await createE2E((config) => {
    config.agents["delayed-child"] = { model: "openai/gpt-5.6-luna", mode: "subagent" }
  })
  try {
    const sessionID = await createSession(e2e, "Delayed-Queue-Subagent")
    e2e.proxy.mock.prependFixture({
      match: { userMessage: "E2E_DQ_SUBAGENT_TURN", sequenceIndex: 0 },
      response: {
        toolCalls: [
          {
            id: "call_dq_subagent",
            name: "subagent",
            arguments: JSON.stringify({
              agent: "delayed-child",
              description: "Delayed queue child",
              prompt: "E2E_DQ_CHILD_WORK",
            }),
          },
        ],
      },
    })
    e2e.proxy.mock.prependFixture({
      match: { toolCallId: "call_dq_subagent" },
      response: { content: "SUBAGENT_STARTED" },
    })
    e2e.proxy.mock.prependFixture({
      match: { userMessage: /E2E_DQ_CHILD_WORK/ },
      response: { content: "CHILD_DONE" },
      latency: 4_000,
    })
    e2e.proxy.mock.prependFixture({ match: { userMessage: /CHILD_DONE/ }, response: { content: "SUBAGENT_NOTICE_OK" } })
    e2e.proxy.mock.prependFixture({
      match: { userMessage: "E2E_DQ_SUBAGENT_DELIVERED" },
      response: { content: "SUBAGENT_DELIVERED_OK" },
    })

    await prompt(e2e, sessionID, "E2E_DQ_SUBAGENT_TURN")
    await waitFor(async () => {
      const jobs = await api<{ data: Array<Record<string, any>> }>(e2e, `/api/experimental/job${locationQuery(e2e)}&sessionID=${sessionID}`)
      return jobs.data.some((job) => job.kind === "subagent" && job.status === "running")
    }, "subagent was not registered", 15_000)

    const status = await rpc<Status>(e2e, "enqueue", { sessionID, text: "E2E_DQ_SUBAGENT_DELIVERED" })
    expect(status.waitingFor.some((work) => work.kind === "subagent")).toBe(true)
    await Bun.sleep(500)
    expect((await userTexts(e2e, sessionID)).includes("E2E_DQ_SUBAGENT_DELIVERED")).toBe(false)
    await waitFor(
      async () => (await userTexts(e2e, sessionID)).includes("E2E_DQ_SUBAGENT_DELIVERED"),
      "delayed message did not wait for the subagent",
      25_000,
    )
  } finally {
    await e2e.close()
  }
})
