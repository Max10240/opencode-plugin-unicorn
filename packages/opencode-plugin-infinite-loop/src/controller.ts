export type InfiniteLoopBackground = {
  readonly sessionID: string
  readonly kind: string
}

export type InfiniteLoopOutcomeReason = "expired" | "stopped"

export type InfiniteLoopOutcome = {
  readonly reason: InfiniteLoopOutcomeReason
  readonly at: number
  readonly sentCount?: number
  readonly lastSentAt?: number
}

export type InfiniteLoopPhase = "waiting" | "quiet" | "checking" | "paused"

export type InfiniteLoopStatus = {
  readonly active: boolean
  readonly startedAt?: number
  readonly deadline?: number
  readonly sentCount?: number
  readonly lastSentAt?: number
  readonly lastInputAt?: number
  readonly cooldownMs?: number
  readonly cooldownUntil?: number
  readonly nextNudgeAt?: number
  readonly phase?: InfiniteLoopPhase
  readonly nudging?: boolean
  readonly outcome?: InfiniteLoopOutcome
}

export type InfiniteLoopAbort =
  | { readonly type: "failed" }
  | { readonly type: "interrupted"; readonly reason: string }

export type InfiniteLoopTimers = {
  setTimeout(run: () => void, delay: number): unknown
  clearTimeout(timer: unknown): void
}

export type InfiniteLoopControllerOptions = {
  readonly delayMs: number
  readonly recheckMs: number
  readonly cooldownMs: number
  readonly now: () => number
  readonly timers: InfiniteLoopTimers
  readonly isBusy: (sessionID: string) => Promise<boolean>
  /**
   * Live check for background work the idle snapshot cannot see: running background shells,
   * images, and busy descendants. When present it gates every nudge, so recovery paths never
   * fire while work from an interrupted turn is still running.
   */
  readonly hasRunningWork?: (sessionID: string) => Promise<boolean>
  readonly send: (sessionID: string) => Promise<void>
  readonly onError: (error: unknown, sessionID: string) => void
  readonly onState?: (sessionID: string, status: InfiniteLoopStatus) => void
}

type TimerMode = "fire" | "recheck" | "deadline"

type Task = {
  readonly sessionID: string
  readonly startedAt: number
  readonly deadline: number
  readonly cooldownMs: number
  sentCount: number
  lastSentAt?: number
  lastInputAt?: number
  generation: number
  phase: InfiniteLoopPhase
  timer?: unknown
  timerAt?: number
  timerMode?: TimerMode
}

/** Node and Bun fire a later timer immediately, so long waits are split into chunks. */
const MAX_TIMER_MS = 2_147_000_000

/**
 * Owns the infinite-loop state for one OpenCode process. Pure with respect to time and effects:
 * timers, busy lookups, and nudges are injected, which keeps the loop testable without a server.
 *
 * Loop flow per session:
 * - `onIdle` runs at the idle boundary. Any background work rechecks until it quiets.
 * - With no background work, `fireAt = max(now + delayMs, lastSentAt + cooldownMs)`.
 *   A cooldown is measured from the last successful nudge, not from the check that noticed it.
 * - At `fireAt` the session is checked again; any new input, stop, or new task invalidates the
 *   attempt through the task generation counter.
 * - The nudge is sent only after a final busy/background check. The cycle repeats until the
 *   task's deadline.
 */
export class InfiniteLoopController {
  private readonly tasks = new Map<string, Task>()
  private readonly outcomes = new Map<string, InfiniteLoopOutcome>()
  /** Latest background list observed at each session's idle boundary, keyed by session ID. */
  private readonly backgrounds = new Map<string, readonly InfiniteLoopBackground[]>()

  constructor(private readonly options: InfiniteLoopControllerOptions) {}

  start(sessionID: string, durationMs: number, alreadyIdle: boolean, cooldownMs = this.options.cooldownMs): InfiniteLoopStatus {
    const now = this.options.now()
    const previous = this.tasks.get(sessionID)
    if (previous) this.clearTimer(previous)
    const task: Task = {
      sessionID,
      startedAt: now,
      deadline: now + Math.max(1, Math.round(durationMs)),
      cooldownMs: Math.max(0, Math.round(cooldownMs)),
      sentCount: 0,
      generation: (previous?.generation ?? 0) + 1,
      phase: "waiting",
    }
    this.tasks.set(sessionID, task)
    this.outcomes.delete(sessionID)
    this.backgrounds.delete(sessionID)
    if (alreadyIdle) this.armFire(task)
    else this.arm(task, "deadline", task.deadline)
    return this.emit(sessionID)
  }

  stop(sessionID: string): InfiniteLoopStatus {
    if (this.tasks.has(sessionID)) this.finish(sessionID, "stopped")
    return this.emit(sessionID)
  }

  hasTask(sessionID: string): boolean {
    return this.tasks.has(sessionID)
  }

  activeStatuses(): Array<{ sessionID: string; status: InfiniteLoopStatus }> {
    return [...this.tasks.keys()].map((sessionID) => ({ sessionID, status: this.status(sessionID) }))
  }

  status(sessionID: string): InfiniteLoopStatus {
    const task = this.tasks.get(sessionID)
    if (!task) {
      const outcome = this.outcomes.get(sessionID)
      if (!outcome) return { active: false }
      return {
        active: false,
        ...(outcome.sentCount === undefined ? {} : { sentCount: outcome.sentCount }),
        ...(outcome.lastSentAt === undefined ? {} : { lastSentAt: outcome.lastSentAt }),
        outcome,
      }
    }
    return {
      active: true,
      startedAt: task.startedAt,
      deadline: task.deadline,
      sentCount: task.sentCount,
      ...(task.lastSentAt === undefined ? {} : { lastSentAt: task.lastSentAt }),
      ...(task.lastInputAt === undefined ? {} : { lastInputAt: task.lastInputAt }),
      cooldownMs: task.cooldownMs,
      ...(task.lastSentAt === undefined ? {} : { cooldownUntil: task.lastSentAt + task.cooldownMs }),
      ...(task.timerMode === "fire" && task.timerAt !== undefined ? { nextNudgeAt: task.timerAt } : {}),
      phase: task.phase,
      nudging: task.phase === "quiet" || task.phase === "checking",
    }
  }

  /** Runs when any session finishes model work and is about to go idle. */
  onIdle(sessionID: string, background: readonly InfiniteLoopBackground[]): void {
    this.backgrounds.set(sessionID, background)
    const task = this.tasks.get(sessionID)
    if (!task) return
    // The idle boundary is authoritative: drop stale quiet windows and rechecks.
    task.generation += 1
    this.clearTimer(task)
    if (this.options.now() >= task.deadline) {
      this.finish(sessionID, "expired")
      return
    }
    task.phase = "waiting"
    if (background.length > 0) {
      this.arm(task, "recheck", Math.min(this.options.now() + this.options.recheckMs, task.deadline))
      this.emit(sessionID)
      return
    }
    this.armFire(task)
  }

  /** Runs whenever a prompt enters a session; non-own input cancels the pending nudge. */
  onPrompt(sessionID: string, own: boolean): void {
    if (own) return
    this.onInput(sessionID)
  }

  /** Runs when a user or synthetic item is queued but not delivered yet. */
  onInboxEnqueued(sessionID: string, own: boolean): void {
    if (own) return
    this.onInput(sessionID)
  }

  /** A queued user message was cancelled before delivery; re-evaluate the idle session. */
  onInputCancelled(sessionID: string): void {
    const task = this.tasks.get(sessionID)
    if (!task) return
    task.generation += 1
    this.clearTimer(task)
    if (this.options.now() >= task.deadline) {
      this.finish(sessionID, "expired")
      return
    }
    task.phase = "waiting"
    this.arm(task, "recheck", Math.min(this.options.now() + this.options.recheckMs, task.deadline))
    this.emit(sessionID)
  }

  /**
   * Runs when a task session's execution ends abnormally, published on the event stream as
   * `session.execution.failed` or `session.execution.interrupted`. Failures and system
   * interrupts (shutdown, superseded, inactivity) keep the loop going; a manual user
   * interruption pauses until the next turn that completes normally.
   */
  onAborted(sessionID: string, abort: InfiniteLoopAbort): void {
    const task = this.tasks.get(sessionID)
    if (!task) return
    task.generation += 1
    this.clearTimer(task)
    if (abort.type === "interrupted" && abort.reason === "user") {
      task.phase = "paused"
      this.arm(task, "deadline", task.deadline)
      this.emit(sessionID)
      return
    }
    if (this.options.now() >= task.deadline) {
      this.finish(sessionID, "expired")
      return
    }
    task.phase = "waiting"
    this.arm(task, "recheck", Math.min(this.options.now() + this.options.recheckMs, task.deadline))
    this.emit(sessionID)
  }

  dispose(): void {
    for (const task of this.tasks.values()) this.clearTimer(task)
    this.tasks.clear()
    this.outcomes.clear()
    this.backgrounds.clear()
  }

  private onInput(sessionID: string): void {
    const task = this.tasks.get(sessionID)
    if (!task) return
    task.generation += 1
    task.lastInputAt = this.options.now()
    this.clearTimer(task)
    task.phase = "waiting"
    // The session is now busy or has a queued user message. Only the deadline timer remains;
    // the next idle boundary or abort event re-arms the loop.
    this.arm(task, "deadline", task.deadline)
    this.emit(sessionID)
  }

  private armFire(task: Task): void {
    const now = this.options.now()
    const cooldownUntil = task.lastSentAt === undefined ? 0 : task.lastSentAt + task.cooldownMs
    const at = Math.max(now + this.options.delayMs, cooldownUntil)
    if (at >= task.deadline) {
      task.phase = "waiting"
      this.arm(task, "deadline", task.deadline)
      this.emit(task.sessionID)
      return
    }
    task.phase = "quiet"
    this.arm(task, "fire", at)
    this.emit(task.sessionID)
  }

  private arm(task: Task, mode: TimerMode, at: number): void {
    this.clearTimer(task)
    const now = this.options.now()
    const intended = Math.min(at, task.deadline)
    task.timerMode = mode
    task.timerAt = intended
    const scheduled = Math.min(intended, now + MAX_TIMER_MS)
    const delay = Math.max(0, scheduled - now)
    const generation = task.generation
    task.timer = this.options.timers.setTimeout(() => {
      if (this.tasks.get(task.sessionID) !== task || task.generation !== generation) return
      task.timer = undefined
      const current = this.options.now()
      if (current >= task.deadline) {
        this.finish(task.sessionID, "expired")
        return
      }
      if (current < intended) {
        this.arm(task, mode, intended)
        return
      }
      if (mode === "fire") void this.checkAndSend(task, generation)
      else void this.recheck(task, generation)
    }, delay)
  }

  private clearTimer(task: Task): void {
    if (task.timer !== undefined) {
      this.options.timers.clearTimeout(task.timer)
      task.timer = undefined
    }
    task.timerAt = undefined
    task.timerMode = undefined
  }

  private async recheck(task: Task, generation: number): Promise<void> {
    if (!this.current(task, generation)) return
    const now = this.options.now()
    if (now >= task.deadline) {
      this.finish(task.sessionID, "expired")
      return
    }
    task.phase = "waiting"
    if (await this.busy(task.sessionID)) {
      if (this.current(task, generation)) this.arm(task, "recheck", Math.min(this.options.now() + this.options.recheckMs, task.deadline))
      return
    }
    if (!this.current(task, generation)) return
    if (this.options.now() >= task.deadline) {
      this.finish(task.sessionID, "expired")
      return
    }
    if (await this.runningWork(task.sessionID)) {
      if (this.current(task, generation)) this.arm(task, "recheck", Math.min(this.options.now() + this.options.recheckMs, task.deadline))
      return
    }
    if (!this.current(task, generation)) return
    if (this.options.now() >= task.deadline) {
      this.finish(task.sessionID, "expired")
      return
    }
    this.armFire(task)
  }

  private async checkAndSend(task: Task, generation: number): Promise<void> {
    if (!this.current(task, generation)) return
    if (this.options.now() >= task.deadline) {
      this.finish(task.sessionID, "expired")
      return
    }
    task.phase = "checking"
    this.emit(task.sessionID)
    if (await this.busy(task.sessionID)) {
      if (this.current(task, generation)) this.arm(task, "recheck", Math.min(this.options.now() + this.options.recheckMs, task.deadline))
      return
    }
    // A stop, expiry, or new input during the busy lookup cancels the send.
    if (!this.current(task, generation)) return
    if (this.options.now() >= task.deadline) {
      this.finish(task.sessionID, "expired")
      return
    }
    if (await this.runningWork(task.sessionID)) {
      if (this.current(task, generation)) this.arm(task, "recheck", Math.min(this.options.now() + this.options.recheckMs, task.deadline))
      return
    }
    if (!this.current(task, generation)) return
    if (this.options.now() >= task.deadline) {
      this.finish(task.sessionID, "expired")
      return
    }
    try {
      await this.options.send(task.sessionID)
    } catch (error) {
      this.options.onError(error, task.sessionID)
      if (this.current(task, generation)) this.arm(task, "recheck", Math.min(this.options.now() + this.options.recheckMs, task.deadline))
      return
    }
    if (!this.current(task, generation)) return
    task.sentCount += 1
    task.lastSentAt = this.options.now()
    task.phase = "waiting"
    this.emit(task.sessionID)
    // The nudge turn may end interrupted or failed, which does not run the idle hook;
    // poll so the loop recovers on its own.
    this.arm(task, "recheck", Math.min(this.options.now() + this.options.recheckMs, task.deadline))
  }

  private current(task: Task, generation: number): boolean {
    return this.tasks.get(task.sessionID) === task && task.generation === generation
  }

  private async busy(sessionID: string): Promise<boolean> {
    try {
      return await this.options.isBusy(sessionID)
    } catch (error) {
      this.options.onError(error, sessionID)
      return true
    }
  }

  /** True holds the nudge. Failures hold it rather than risking a send over unknown work. */
  private async runningWork(sessionID: string): Promise<boolean> {
    if (this.options.hasRunningWork !== undefined) {
      try {
        return await this.options.hasRunningWork(sessionID)
      } catch (error) {
        this.options.onError(error, sessionID)
        return true
      }
    }
    // Older host without a live check: fall back to the idle snapshot registry.
    const known = this.backgrounds.get(sessionID) ?? []
    if (known.some((work) => work.sessionID === sessionID)) return true
    const owners = new Set(known.filter((work) => work.sessionID !== sessionID).map((work) => work.sessionID))
    for (const owner of owners) {
      if (await this.busy(owner)) return true
      if ((this.backgrounds.get(owner) ?? []).length > 0) return true
    }
    return false
  }

  private finish(sessionID: string, reason: InfiniteLoopOutcomeReason): void {
    const task = this.tasks.get(sessionID)
    if (task) this.clearTimer(task)
    this.tasks.delete(sessionID)
    this.backgrounds.delete(sessionID)
    this.outcomes.set(sessionID, {
      reason,
      at: this.options.now(),
      ...(task && task.sentCount > 0 ? { sentCount: task.sentCount } : {}),
      ...(task?.lastSentAt === undefined ? {} : { lastSentAt: task.lastSentAt }),
    })
    this.emit(sessionID)
  }

  private emit(sessionID: string): InfiniteLoopStatus {
    const status = this.status(sessionID)
    this.options.onState?.(sessionID, status)
    return status
  }
}

/** A session is busy when its last execution start is newer than its last terminal transition. */
export function isSessionBusy(info: { readonly time?: { readonly busy?: number; readonly idle?: number } } | undefined | null): boolean {
  const busy = info?.time?.busy
  if (busy === undefined) return false
  const idle = info?.time?.idle
  if (idle === undefined) return true
  return busy > idle
}
