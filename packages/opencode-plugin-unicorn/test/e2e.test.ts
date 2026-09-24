import { expect, test } from "bun:test"
import { access, readFile, writeFile } from "node:fs/promises"
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
    const requestKinds = e2e.proxy.requests.map((request) => request.kind)
    expect(requestKinds).toEqual(["compaction", "primary"])
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

test("integrates image generation as an independently switchable Unicorn feature", async () => {
  const enabled = await createOpenCodeE2E({ imageGenEnabled: true })
  try {
    await enabled.waitForModelContext(1_000_000)

    const originalImage = Buffer.from("keep-existing-image")
    await writeFile(`${enabled.workspace}/e2e-image.png`, originalImage)
    const result = await enabled.runImagePrompt()
    expect(result.messages.some((message) => message.type === "user" && message.text === "E2E_IMAGE_GEN")).toBe(true)
    expect(enabled.proxy.requests.some((request) => request.tools.includes("image_gen"))).toBe(true)
    expect(enabled.proxy.imageRequests).toBe(1)
    expect(await readFile(`${enabled.workspace}/e2e-image.png`)).toEqual(originalImage)
    await access(`${enabled.workspace}/e2e-image-v2.png`)

    const referenceImage = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      "base64",
    )
    await writeFile(`${enabled.workspace}/e2e-reference.png`, referenceImage)
    const edit = await enabled.runImagePrompt("edit")
    expect(edit.messages.some((message) => message.type === "user" && message.text === "E2E_IMAGE_EDIT")).toBe(true)
    expect(enabled.proxy.imageEditRequests).toBe(1)
    await access(`${enabled.workspace}/e2e-edit.png`)
  } finally {
    await enabled.close()
  }

  const disabled = await createOpenCodeE2E({ imageGenEnabled: false })
  try {
    await disabled.waitForModelContext(1_000_000)
    await disabled.runImagePrompt()
    expect(disabled.proxy.requests.some((request) => request.tools.includes("image_gen"))).toBe(false)
    expect(disabled.proxy.imageRequests).toBe(0)
    await expect(access(`${disabled.workspace}/e2e-image.png`)).rejects.toThrow()
  } finally {
    await disabled.close()
  }

  const standalone = await createOpenCodeE2E({ plugin: "image-gen" })
  try {
    await standalone.waitForModelContext(DEFAULT_LOW_LIMIT.context)
    const result = await standalone.runImagePrompt()
    expect(result.messages.some((message) => message.type === "user" && message.text === "E2E_IMAGE_GEN")).toBe(true)
    expect(standalone.proxy.requests.some((request) => request.tools.includes("image_gen"))).toBe(true)
    expect(standalone.proxy.imageRequests).toBe(1)
    await access(`${standalone.workspace}/e2e-image.png`)
  } finally {
    await standalone.close()
  }
})
