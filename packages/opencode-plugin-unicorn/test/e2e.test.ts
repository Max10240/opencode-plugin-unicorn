import { expect, test } from "bun:test"
import { createOpenCodeE2E, DEFAULT_LOW_LIMIT } from "./e2e-utils.js"

test("updates the real global config and avoids compaction with the larger Luna context", async () => {
  const e2e = await createOpenCodeE2E()
  try {
    const model = await e2e.waitForModelContext(1_000_000)
    expect(model.limit).toEqual({ context: 1_000_000, input: 922_000, output: 128_000 })

    const config = await e2e.config()
    expect(config.share).toBe("disabled")
    expect(config.providers.openai.models["gpt-5.6-luna"].settings.baseURL).toBe(e2e.proxy.baseURL)

    const result = await e2e.runLargePrompt()
    expect(result.messages.some((message) => message.type === "compaction")).toBe(false)
    expect(e2e.proxy.requests.map((request) => request.kind)).toEqual(["primary"])
  } finally {
    await e2e.close()
  }
})

test("without the feature, the same real OpenCode session compacts at the low limit", async () => {
  const e2e = await createOpenCodeE2E({ featureEnabled: false, share: "manual" })
  try {
    const model = await e2e.waitForModelContext(DEFAULT_LOW_LIMIT.context)
    expect(model.limit).toEqual(DEFAULT_LOW_LIMIT)
    expect((await e2e.config()).share).toBe("manual")

    const result = await e2e.runLargePrompt()
    const compactions = result.messages.filter((message) => message.type === "compaction")
    expect(compactions).toHaveLength(1)
    expect(compactions[0]).toMatchObject({ status: "completed", reason: "auto" })
    expect(e2e.proxy.requests.map((request) => request.kind)).toEqual(["compaction", "primary"])
  } finally {
    await e2e.close()
  }
})

test("preserves an existing share policy while applying the global model configuration", async () => {
  const e2e = await createOpenCodeE2E({ share: "manual" })
  try {
    await e2e.waitForModelContext(1_000_000)
    expect((await e2e.config()).share).toBe("manual")

    const result = await e2e.runLargePrompt()
    expect(result.messages.some((message) => message.type === "compaction")).toBe(false)
    expect(e2e.proxy.requests.map((request) => request.kind)).toEqual(["primary"])
  } finally {
    await e2e.close()
  }
})
