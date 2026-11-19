import { Plugin } from "@opencode/plugin"
import type { Context } from "@opencode/plugin/promise/plugin"
import { DeadLoopController, isSessionBusy } from "./controller.js"
import { deadLoopEnabled, parseDeadLoopOptions, type DeadLoopOptions } from "./options.js"
import { DeadLoopRpc, toStatusPayload } from "./rpc.js"

type PluginContext = Pick<Context, "options" | "rpc" | "session">

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export async function setupDeadLoop(context: PluginContext) {
  let options: DeadLoopOptions
  try {
    options = parseDeadLoopOptions(context.options)
  } catch (error) {
    console.warn(`Dead loop disabled: ${describe(error)}`)
    return async () => {}
  }
  if (!options.enabled || !deadLoopEnabled(context.options) || !context.rpc) return async () => {}
  if (typeof context.session?.hook !== "function") {
    console.warn("Dead loop disabled: the running OpenCode does not expose the experimental.idle session hook")
    return async () => {}
  }

  const controller = new DeadLoopController({
    delayMs: options.delayMs,
    recheckMs: options.recheckMs,
    now: () => Date.now(),
    timers: { setTimeout, clearTimeout },
    isBusy: async (sessionID) => isSessionBusy(await context.session.get({ sessionID })),
    send: async (sessionID) => {
      await context.session.prompt({ sessionID, text: options.message, metadata: { deadLoop: true } })
    },
    onError: (error, sessionID) => {
      console.warn(`Dead loop nudge failed for ${sessionID}: ${describe(error)}`)
    },
  })

  const idleHook = await context.session.hook("experimental.idle", (event) => {
    try {
      controller.onIdle(event.sessionID, event.background)
    } catch (error) {
      console.warn(`Dead loop idle handling failed for ${event.sessionID}: ${describe(error)}`)
    }
  })
  const promptHook = await context.session.hook("prompt", (event) => {
    const own = isRecord(event.metadata) && event.metadata.deadLoop === true
    try {
      controller.onPrompt(event.sessionID, own)
    } catch (error) {
      console.warn(`Dead loop prompt handling failed for ${event.sessionID}: ${describe(error)}`)
    }
  })

  const busy = async (sessionID: string) => {
    try {
      return isSessionBusy(await context.session.get({ sessionID }))
    } catch {
      return true
    }
  }

  const registration = await context.rpc.register(DeadLoopRpc, {
    status: async (raw) => {
      const input = raw as { sessionID: string }
      return toStatusPayload(controller.status(input.sessionID))
    },
    start: async (raw, request) => {
      const input = raw as { sessionID: string; durationMs: number }
      if (typeof input.durationMs !== "number" || !Number.isFinite(input.durationMs) || input.durationMs <= 0) {
        return request.error("invalid", "durationMs must be a positive number of milliseconds", {})
      }
      const clamped = Math.min(Math.max(Math.round(input.durationMs), options.minDurationMs), options.maxDurationMs)
      const alreadyIdle = !(await busy(input.sessionID))
      return toStatusPayload(controller.start(input.sessionID, clamped, alreadyIdle))
    },
    stop: async (raw) => {
      const input = raw as { sessionID: string }
      return toStatusPayload(controller.stop(input.sessionID))
    },
  })

  return async () => {
    controller.dispose()
    await idleHook.dispose()
    await promptHook.dispose()
    await registration.dispose()
  }
}

export default Plugin.define({
  id: "max10240.dead-loop",
  async setup(context) {
    return setupDeadLoop(context)
  },
})

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
