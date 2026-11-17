import type { Context } from "@opencode/plugin/promise/plugin"
import { GOD_AGENT_ID, parseGodOptions, selectPromptSource } from "./options.js"
import { PromptLoader } from "./prompt.js"

export type GodPluginContext = Pick<Context, "agent" | "session" | "options"> & {
  readonly location?: {
    readonly directory: string
  }
}

export type SetupGodAgentDeps = {
  readonly log?: (message: string) => void
}

const GOD_AGENT_DESCRIPTION = "Uses the model-specific system prompt configured for this agent."

export async function setupGodAgent(
  context: GodPluginContext,
  deps: SetupGodAgentDeps = {},
): Promise<() => Promise<void>> {
  const log = deps.log ?? ((message: string) => console.warn(message))
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

      const source = selectPromptSource(options, String(input.model.id))
      if (!source) return

      const result = await loader.load(source)
      if (result.error) {
        log(`[god] unable to load system prompt from ${source}: ${result.error}`)
        return
      }

      const text = result.text ?? ""
      if (!text.trim()) {
        log(`[god] system prompt source is empty: ${source}`)
        return
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
