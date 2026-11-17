import type { Context } from "@opencode/plugin/promise/plugin"
import { GOD_AGENT_ID, parseGodOptions, selectPromptSource } from "./options.js"
import { PromptLoader } from "./prompt.js"

export type GodPluginContext = Pick<Context, "agent" | "session" | "options"> & {
  readonly location?: {
    readonly directory: string
  }
}

const GOD_AGENT_DESCRIPTION = "Uses the model-specific system prompt configured for this agent."

export async function setupGodAgent(context: GodPluginContext): Promise<() => Promise<void>> {
  const options = parseGodOptions(context.options)
  const loader = new PromptLoader({
    directory: context.location?.directory ?? process.cwd(),
    cache: options.cache,
    cacheTtlMs: options.cacheTtlMs,
    timeoutMs: options.timeoutMs,
  })

  const agentRegistration = await context.agent.transform((editor) => {
    const exists = editor.get(GOD_AGENT_ID) !== undefined
    editor.update(GOD_AGENT_ID, (agent) => {
      if (exists) return
      agent.description = GOD_AGENT_DESCRIPTION
      agent.mode = "primary"
    })
  })

  const hookRegistration = await context.session
    .hook("context", async (input) => {
      if (String(input.agent) !== GOD_AGENT_ID) return

      const modelID = String(input.model.id)
      const source = selectPromptSource(options, modelID)
      if (!source) {
        throw new Error(`[god] no system prompt configured for model "${modelID}"`)
      }

      const result = await loader.load(source)
      if (result.error) {
        throw new Error(`[god] failed to load system prompt for model "${modelID}" from ${source}: ${result.error}`)
      }

      const text = result.text ?? ""
      if (!text.trim()) {
        throw new Error(`[god] system prompt for model "${modelID}" is empty: ${source}`)
      }

      input.system.splice(0, input.system.length, { type: "text", text })
    })
    .catch(async (error) => {
      await agentRegistration.dispose()
      throw error
    })

  return async () => {
    try {
      await hookRegistration.dispose()
    } finally {
      await agentRegistration.dispose()
    }
  }
}
