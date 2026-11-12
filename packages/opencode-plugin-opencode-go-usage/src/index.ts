import { Plugin } from "@opencode/plugin"
import type { Context } from "@opencode/plugin/promise/plugin"
import { usageEnabled } from "./options.js"
import { OpencodeGoUsageRpc } from "./rpc.js"
import { INTEGRATION_ID, listAccountRefs, listAccountUsage, type UsageSource } from "./usage.js"

type ServerContext = Pick<Context, "options" | "rpc" | "integration">

export default Plugin.define({
  id: "max10240.opencode-go-usage",
  setup: setupOpencodeGoUsage,
})

export async function setupOpencodeGoUsage(context: ServerContext) {
  if (!usageEnabled(context.options) || !context.rpc || !context.integration) return async () => {}

  const source: UsageSource = {
    get: (input) => context.integration.get(input).then((output) => output.data),
    active: () => context.integration.connection.active(INTEGRATION_ID),
    resolve: (connection) => context.integration.connection.resolve(connection),
  }

  const registration = await context.rpc.register(OpencodeGoUsageRpc, {
    accounts: async () => {
      try {
        return { accounts: await listAccountRefs(source) }
      } catch {
        return { accounts: [] }
      }
    },
    list: async () => ({ accounts: await listAccountUsage(source) }),
  })

  return async () => {
    await registration.dispose()
  }
}
