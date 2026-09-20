import { Plugin } from "@opencode/plugin"
import { setupSendMessageAcrossSessions } from "./setup.js"

export default Plugin.define({
  id: "max10240.send-message-across-sessions",
  setup: setupSendMessageAcrossSessions,
})

export { MESSAGE_PREFIX, setupSendMessageAcrossSessions } from "./setup.js"
export { listOnlineSessions } from "./session-directory.js"
