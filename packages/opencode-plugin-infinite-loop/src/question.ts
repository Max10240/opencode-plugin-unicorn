/** The built-in tool an agent uses to ask the user a question. */
export const QUESTION_TOOL = "question"

export type QuestionGate = {
  /** True while a loop owns the session. A paused task still owns it until an explicit stop. */
  readonly hasLoop: (sessionID: string) => boolean
  readonly parentOf: (sessionID: string) => string | undefined
}

/**
 * True when a question would stall a running loop. A question in a subagent session stalls its
 * parent's task just as one in the task session does, so the walk climbs to the root session.
 */
export function blocksQuestion(sessionID: string, gate: QuestionGate): boolean {
  let current: string | undefined = sessionID
  const seen = new Set<string>()
  while (current !== undefined && !seen.has(current)) {
    seen.add(current)
    if (gate.hasLoop(current)) return true
    current = gate.parentOf(current)
  }
  return false
}
