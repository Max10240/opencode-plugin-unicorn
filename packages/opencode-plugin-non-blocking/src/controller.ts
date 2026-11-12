export type ToolKind = "shell" | "subagent"

export type ToolSnapshot = {
  id: string
  name: string
  status: string
  created: number
  ran?: number
  metadata?: Readonly<Record<string, unknown>>
}

export type ShellSnapshot = {
  status: string
  started?: number
}

export type SessionSnapshot = {
  sessionID: string
  assistantMessageID: string
  tools: readonly ToolSnapshot[]
}

export type InputStarted = {
  sessionID: string
  assistantMessageID: string
  id: string
  name: string
}

export type ToolCalled = {
  sessionID: string
  assistantMessageID: string
  id: string
  created: number
}

export type ToolProgress = ToolCalled & {
  metadata: Readonly<Record<string, unknown>>
}

export type ToolSettled = {
  sessionID: string
  assistantMessageID: string
  id: string
}

export type Timer = ReturnType<typeof setTimeout>

export type ControllerOptions = {
  thresholdMs: number
  background: (sessionID: string) => Promise<unknown>
  lookupTool?: (sessionID: string, assistantMessageID: string, toolID: string) => ToolSnapshot | undefined
  lookupShell?: (shellID: string) => ShellSnapshot | undefined
  now?: () => number
  setTimeout?: (callback: () => void, delay: number) => Timer
  clearTimeout?: (timer: Timer) => void
  retryDelays?: readonly number[]
  onBackground?: (sessionID: string) => void
  onError?: (error: unknown, sessionID: string) => void
}

type Candidate = {
  sessionID: string
  assistantMessageID: string
  toolID: string
  kind: ToolKind
  shellID?: string
  startedAt: number
  timer?: Timer
  settled: boolean
}

const DEFAULT_RETRY_DELAYS = [1_000, 3_000, 5_000] as const
const MAX_TIMER_DELAY = 2_147_483_647

export function toolKind(name: string): ToolKind | undefined {
  if (name === "bash" || name === "shell") return "shell"
  if (name === "task" || name === "subagent") return "subagent"
}

export function metadataKind(metadata: Readonly<Record<string, unknown>> | undefined): ToolKind | undefined {
  if (!metadata) return
  if (typeof metadata.shellID === "string" && metadata.shellID.startsWith("sh_")) return "shell"
  if (
    metadata.status === "running" &&
    typeof metadata.sessionID === "string" &&
    metadata.sessionID.startsWith("ses_")
  )
    return "subagent"
}

function metadataString(metadata: Readonly<Record<string, unknown>> | undefined, key: string) {
  const value = metadata?.[key]
  return typeof value === "string" && value ? value : undefined
}

function validStart(value: number | undefined) {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : undefined
}

function eventKey(sessionID: string, assistantMessageID: string, toolID: string) {
  return `${sessionID}:${assistantMessageID}:${toolID}`
}

export class NonBlockingController {
  private readonly candidates = new Map<string, Candidate>()
  private readonly names = new Map<string, ToolKind>()
  private readonly shellStarts = new Map<string, number>()
  private readonly inFlight = new Set<string>()
  private readonly retries = new Map<string, number>()
  private readonly retryDelays: readonly number[]
  private readonly now: () => number
  private readonly scheduleTimer: (callback: () => void, delay: number) => Timer
  private readonly cancelTimer: (timer: Timer) => void
  private stopped = false
  constructor(private readonly options: ControllerOptions) {
    this.retryDelays = options.retryDelays ?? DEFAULT_RETRY_DELAYS
    this.now = options.now ?? Date.now
    this.scheduleTimer = options.setTimeout ?? ((callback, delay) => setTimeout(callback, delay))
    this.cancelTimer = options.clearTimeout ?? clearTimeout
  }

  inputStarted(input: InputStarted) {
    if (this.stopped) return
    const kind = toolKind(input.name)
    if (kind) this.names.set(eventKey(input.sessionID, input.assistantMessageID, input.id), kind)
  }

  toolCalled(input: ToolCalled) {
    if (this.stopped) return
    const key = eventKey(input.sessionID, input.assistantMessageID, input.id)
    const tool = this.options.lookupTool?.(input.sessionID, input.assistantMessageID, input.id)
    const kind = this.names.get(key) ?? toolKind(tool?.name ?? "")
    if (!kind) return
    this.upsert({
      sessionID: input.sessionID,
      assistantMessageID: input.assistantMessageID,
      toolID: input.id,
      kind,
      shellID: metadataString(tool?.metadata, "shellID"),
      startedAt: this.startFor(kind, tool?.metadata, tool, input.created),
    })
  }

  toolProgress(input: ToolProgress) {
    if (this.stopped) return
    const key = eventKey(input.sessionID, input.assistantMessageID, input.id)
    const known = this.names.get(key)
    if (!known && !metadataKind(input.metadata)) return
    const tool = this.options.lookupTool?.(input.sessionID, input.assistantMessageID, input.id)
    const kind = known ?? toolKind(tool?.name ?? "") ?? metadataKind(input.metadata)
    if (!kind) return
    const shellID = metadataString(input.metadata, "shellID") ?? metadataString(tool?.metadata, "shellID")
    this.upsert({
      sessionID: input.sessionID,
      assistantMessageID: input.assistantMessageID,
      toolID: input.id,
      kind,
      shellID,
      startedAt: this.startFor(kind, input.metadata, tool, input.created, shellID),
    })
  }

  shellStarted(shellID: string, startedAt: number) {
    if (this.stopped) return
    const start = validStart(startedAt)
    if (start === undefined) return
    this.shellStarts.set(shellID, start)
    for (const candidate of this.candidates.values()) {
      if (candidate.shellID !== shellID || candidate.startedAt >= start) continue
      candidate.startedAt = start
      this.schedule(candidate)
    }
  }

  toolSettled(input: ToolSettled) {
    const key = eventKey(input.sessionID, input.assistantMessageID, input.id)
    this.names.delete(key)
    const candidate = this.candidates.get(key)
    if (candidate) this.remove(candidate)
  }

  shellSettled(shellID: string) {
    this.shellStarts.delete(shellID)
    for (const candidate of this.candidates.values()) {
      if (candidate.shellID === shellID) this.remove(candidate)
    }
  }

  sessionDeleted(sessionID: string) {
    for (const candidate of [...this.candidates.values()]) {
      if (candidate.sessionID === sessionID) this.remove(candidate)
    }
    for (const key of [...this.names.keys()]) {
      if (key.startsWith(`${sessionID}:`)) this.names.delete(key)
    }
    this.retries.delete(sessionID)
  }

  reconcile(sessions: readonly SessionSnapshot[]) {
    if (this.stopped) return
    for (const session of sessions) {
      for (const tool of session.tools) {
        const kind = toolKind(tool.name)
        if (!kind || tool.status !== "running") continue
        const shellID = metadataString(tool.metadata, "shellID")
        this.upsert({
          sessionID: session.sessionID,
          assistantMessageID: session.assistantMessageID,
          toolID: tool.id,
          kind,
          shellID,
          startedAt: this.startFor(kind, tool.metadata, tool, tool.ran ?? tool.created, shellID),
        })
      }
    }
  }

  stop() {
    this.stopped = true
    for (const candidate of this.candidates.values()) {
      if (candidate.timer !== undefined) this.cancelTimer(candidate.timer)
      candidate.settled = true
    }
    this.candidates.clear()
    this.names.clear()
    this.shellStarts.clear()
    this.retries.clear()
    this.inFlight.clear()
  }

  get size() {
    return this.candidates.size
  }

  private startFor(
    kind: ToolKind,
    metadata: Readonly<Record<string, unknown>> | undefined,
    tool: ToolSnapshot | undefined,
    fallback: number,
    shellID = metadataString(metadata, "shellID"),
  ) {
    if (kind === "shell" && shellID) {
      const started = validStart(this.shellStarts.get(shellID)) ?? validStart(this.options.lookupShell?.(shellID)?.started)
      if (started !== undefined) return started
    }
    return validStart(tool?.ran) ?? validStart(tool?.created) ?? validStart(fallback) ?? this.now()
  }

  private upsert(input: Omit<Candidate, "timer" | "settled">) {
    if (this.stopped) return
    const key = eventKey(input.sessionID, input.assistantMessageID, input.toolID)
    const existing = this.candidates.get(key)
    const startedAt = existing ? Math.max(existing.startedAt, input.startedAt) : input.startedAt
    const candidate: Candidate = {
      ...existing,
      ...input,
      shellID: input.shellID ?? existing?.shellID,
      startedAt,
      settled: false,
    }
    if (existing?.timer !== undefined) this.cancelTimer(existing.timer)
    candidate.timer = undefined
    this.candidates.set(key, candidate)
    this.schedule(candidate)
  }

  private schedule(candidate: Candidate) {
    if (this.stopped || candidate.settled) return
    if (candidate.timer !== undefined) this.cancelTimer(candidate.timer)
    const elapsed = this.now() - candidate.startedAt
    const delay = Math.min(MAX_TIMER_DELAY, Math.max(0, this.options.thresholdMs - elapsed))
    candidate.timer = this.scheduleTimer(() => {
      candidate.timer = undefined
      void this.evaluate(candidate)
    }, delay)
  }

  private scheduleSessionRetry(sessionID: string) {
    if (this.stopped) return
    const candidates = [...this.candidates.values()].filter((candidate) => candidate.sessionID === sessionID)
    if (candidates.length === 0) {
      this.retries.delete(sessionID)
      return
    }
    const attempt = (this.retries.get(sessionID) ?? 0) + 1
    this.retries.set(sessionID, attempt)
    const delay = this.retryDelays[attempt - 1]
    if (delay === undefined) {
      this.failSession(sessionID)
      return
    }
    for (const candidate of candidates) {
      if (candidate.timer !== undefined) this.cancelTimer(candidate.timer)
      candidate.timer = this.scheduleTimer(() => {
        candidate.timer = undefined
        void this.evaluate(candidate)
      }, delay)
    }
  }

  private failSession(sessionID: string) {
    let failed = false
    const now = this.now()
    for (const candidate of [...this.candidates.values()]) {
      if (candidate.sessionID !== sessionID) continue
      if (now - candidate.startedAt < this.options.thresholdMs) continue
      failed = true
      this.remove(candidate)
    }
    this.retries.delete(sessionID)
    if (failed) this.options.onError?.(new Error("Could not move long-running work to the background"), sessionID)
  }

  private async evaluate(candidate: Candidate) {
    if (this.stopped || candidate.settled) return
    const key = eventKey(candidate.sessionID, candidate.assistantMessageID, candidate.toolID)
    if (this.candidates.get(key) !== candidate) return
    if (this.now() - candidate.startedAt < this.options.thresholdMs) {
      this.schedule(candidate)
      return
    }
    const tool = this.options.lookupTool?.(candidate.sessionID, candidate.assistantMessageID, candidate.toolID)
    if (tool && (tool.status !== "running" || toolKind(tool.name) !== candidate.kind)) {
      this.remove(candidate)
      return
    }
    if (candidate.kind === "shell" && candidate.shellID) {
      const shell = this.options.lookupShell?.(candidate.shellID)
      if (shell && shell.status !== "running") {
        this.remove(candidate)
        return
      }
    }
    if (this.inFlight.has(candidate.sessionID)) return
    this.inFlight.add(candidate.sessionID)
    try {
      const callStartedAt = this.now()
      await this.options.background(candidate.sessionID)
      if (this.stopped) return
      this.finishSession(candidate.sessionID, callStartedAt)
      this.options.onBackground?.(candidate.sessionID)
    } catch {
      if (!this.stopped) this.scheduleSessionRetry(candidate.sessionID)
    } finally {
      this.inFlight.delete(candidate.sessionID)
    }
  }

  private finishSession(sessionID: string, callStartedAt: number) {
    for (const candidate of [...this.candidates.values()]) {
      if (candidate.sessionID !== sessionID) continue
      if (candidate.startedAt >= callStartedAt) continue
      this.remove(candidate)
    }
    if (![...this.candidates.values()].some((candidate) => candidate.sessionID === sessionID)) {
      this.retries.delete(sessionID)
    }
  }

  private remove(candidate: Candidate) {
    candidate.settled = true
    if (candidate.timer !== undefined) {
      this.cancelTimer(candidate.timer)
      candidate.timer = undefined
    }
    const key = eventKey(candidate.sessionID, candidate.assistantMessageID, candidate.toolID)
    this.candidates.delete(key)
    this.names.delete(key)
    if (![...this.candidates.values()].some((item) => item.sessionID === candidate.sessionID)) {
      this.retries.delete(candidate.sessionID)
    }
  }
}
