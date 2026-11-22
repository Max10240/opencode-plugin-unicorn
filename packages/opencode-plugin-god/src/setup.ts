import type { Context } from "@opencode/plugin/promise/plugin"
import { GOD_AGENT_ID, parseGodOptions, selectPromptSources } from "./options.js"
import { PromptLoader, type PromptCacheSlot } from "./prompt.js"

export type GodPluginContext = Pick<Context, "agent" | "session" | "options"> & {
  readonly location?: {
    readonly directory: string
  }
  readonly storage?: PromptCacheSlot
}

const GOD_AGENT_DESCRIPTION = "Uses the model-specific system prompt configured for this agent."

export async function setupGodAgent(context: GodPluginContext): Promise<() => Promise<void>> {
  const options = parseGodOptions(context.options)
  const loader = new PromptLoader({
    directory: context.location?.directory ?? process.cwd(),
    cache: options.cache,
    cacheTtlMs: options.cacheTtlMs,
    timeoutMs: options.timeoutMs,
    storage: context.storage,
  })
  const warned = new Set<string>()

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
      const providerID = typeof input.model.providerID === "string" ? input.model.providerID : undefined
      const selected = selectPromptSources(options, modelID, providerID)

      let result = await loader.load(selected.source)
      if (result.error && selected.fallback && selected.fallback !== selected.source) {
        // A built-in file can disappear upstream. Fall back to the shared
        // prompt once instead of leaving the model without one.
        warn(warned, modelID, selected.source, `falling back to the shared prompt (${result.error})`)
        result = await loader.load(selected.fallback)
      }

      const text = result.text ?? ""
      if (result.error || !text.trim()) {
        // Loading is best effort: an unreachable source leaves the model's own
        // system prompt in place instead of failing the request.
        warn(warned, modelID, selected.source, `keeping the default system prompt (${result.error ?? "empty prompt"})`)
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

function warn(warned: Set<string>, modelID: string, source: string, detail: string) {
  if (warned.has(source)) return
  warned.add(source)
  console.warn(`[god] ${modelID}: ${detail} [${source}]`)
}
