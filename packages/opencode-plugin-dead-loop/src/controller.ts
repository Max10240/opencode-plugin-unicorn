export type DeadLoopBackground = {
  readonly sessionID: string
  readonly kind: string
}

export type DeadLoopOutcomeReason = "expired" | "stopped"

export type DeadLoopOutcome = {
  readonly reason: DeadLoopOutcomeReason
  readonly at: number
  readonly sentCount?: number
  readonly lastSentAt?: number
}

export type DeadLoopStatus = {
  readonly active: boolean
  readonly startedAt?: number
  readonly deadline?: number
  readonly sentCount?: number
  readonly lastSentAt?: number
  readonly lastInputAt?: number
  readonly nudging?: boolean
  readonly outcome?: DeadLoopOutcome
}

export type DeadLoopTimers = {
  setTimeout(run: () => void, delay: number): unknown
  clearTimeout(timer: unknown): void
}

export type DeadLoopControllerOptions = {
  readonly delayMs: number
  readonly recheckMs: number
  readonly now: () => number
  readonly timers: DeadLoopTimers
  readonly isBusy: (sessionID: string) => Promise<boolean>
  readonly send: (sessionID: string) => Promise<void>
  readonly onError: (error: unknown, sessionID: string) => void
  readonly onState?: (sessionID: string, status: DeadLoopStatus) => void
}

type Task = {
  readonly sessionID: string
  readonly startedAt: number
  readonly deadline: number
  sentCount: number
  lastSentAt?: number
  lastInputAt?: number
}

/**
 * Owns the dead-loop state for one OpenCode process. Pure with respect to time and effects:
 * timers, busy lookups, and nudges are injected, which keeps the loop testable without a server.
 *
 * Loop flow per session:
 * - `onIdle` runs at the idle boundary. Own background work means the framework wakes the session
 *   and the hook runs again, so the controller just waits. Descendant-owned background work wakes
 *   the descendant instead, so a recheck timer re-evaluates until that work is gone.
 * - With no background work, a quiet window of `delayMs` opens. Any non-dead-loop prompt cancels it.
 * - When the window elapses and the session is still idle, the nudge is sent and the cycle repeats
 *   until the task's deadline passes.
 */
export class DeadLoopController {
  private readonly tasks = new Map<string, Task>()
  private readonly outcomes = new Map<string, DeadLoopOutcome>()
  private readonly quiet = new Map<string, unknown>()
  private readonly rechecks = new Map<string, unknown>()
  /** Latest background list observed at each session's idle boundary, keyed by session ID. */
  private readonly backgrounds = new Map<string, readonly DeadLoopBackground[]>()

  constructor(private readonly options: DeadLoopControllerOptions) {}

  start(sessionID: string, durationMs: number, alreadyIdle: boolean): DeadLoopStatus {
    const now = this.options.now()
    this.cancelTimers(sessionID)
    this.tasks.set(sessionID, { sessionID, startedAt: now, deadline: now + durationMs, sentCount: 0 })
    this.outcomes.delete(sessionID)
    if (alreadyIdle) this.armQuietWindow(sessionID)
    return this.emit(sessionID)
  }

  stop(sessionID: string): DeadLoopStatus {
    if (this.tasks.has(sessionID)) this.finish(sessionID, "stopped")
    return this.emit(sessionID)
  }

  status(sessionID: string): DeadLoopStatus {
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
      nudging: this.quiet.has(sessionID),
    }
  }

  /** Runs when any session finishes model work and is about to go idle. */
  onIdle(sessionID: string, background: readonly DeadLoopBackground[]): void {
    this.backgrounds.set(sessionID, background)
    const task = this.tasks.get(sessionID)
    if (!task) return
    // The idle boundary is authoritative: drop stale quiet windows and rechecks.
    this.cancelTimers(sessionID)
    if (this.options.now() >= task.deadline) {
      this.finish(sessionID, "expired")
      return
    }
    if (background.some((work) => work.sessionID === sessionID)) return
    if (background.length > 0) {
      this.seedOwners(sessionID, background)
      this.scheduleRecheck(sessionID)
      return
    }
    this.armQuietWindow(sessionID)
  }

  /** Runs whenever a prompt enters a session; non-dead-loop input cancels the pending nudge. */
  onPrompt(sessionID: string, own: boolean): void {
    if (own) return
    const task = this.tasks.get(sessionID)
    if (!task) return
    task.lastInputAt = this.options.now()
    this.cancelTimers(sessionID)
    this.emit(sessionID)
  }

  dispose(): void {
    for (const sessionID of [...this.quiet.keys(), ...this.rechecks.keys()]) this.cancelTimers(sessionID)
    this.tasks.clear()
    this.outcomes.clear()
    this.backgrounds.clear()
  }

  private armQuietWindow(sessionID: string): void {
    if (this.quiet.has(sessionID)) return
    const handle = this.options.timers.setTimeout(() => {
      this.quiet.delete(sessionID)
      void this.fire(sessionID)
    }, this.options.delayMs)
    this.quiet.set(sessionID, handle)
    this.emit(sessionID)
  }

  private scheduleRecheck(sessionID: string): void {
    if (this.rechecks.has(sessionID)) return
    const handle = this.options.timers.setTimeout(() => {
      this.rechecks.delete(sessionID)
      void this.recheck(sessionID)
    }, this.options.recheckMs)
    this.rechecks.set(sessionID, handle)
  }

  private async recheck(sessionID: string): Promise<void> {
    const task = this.tasks.get(sessionID)
    if (!task) return
    if (this.options.now() >= task.deadline) {
      this.finish(sessionID, "expired")
      return
    }
    if (await this.busy(sessionID)) {
      this.scheduleRecheck(sessionID)
      return
    }
    const known = this.backgrounds.get(sessionID) ?? []
    if (known.some((work) => work.sessionID === sessionID)) {
      this.scheduleRecheck(sessionID)
      return
    }
    const owners = new Set(known.filter((work) => work.sessionID !== sessionID).map((work) => work.sessionID))
    for (const owner of owners) {
      if (await this.busy(owner)) {
        this.scheduleRecheck(sessionID)
        return
      }
      const ownerBackground = this.backgrounds.get(owner)
      if (ownerBackground !== undefined && ownerBackground.length > 0) {
        this.scheduleRecheck(sessionID)
        return
      }
    }
    this.armQuietWindow(sessionID)
  }

  private async fire(sessionID: string): Promise<void> {
    const task = this.tasks.get(sessionID)
    if (!task) return
    if (this.options.now() >= task.deadline) {
      this.finish(sessionID, "expired")
      return
    }
    if (await this.busy(sessionID)) return
    // A stop or expiry during the busy lookup cancels the pending send.
    if (this.tasks.get(sessionID) !== task) return
    if ((this.backgrounds.get(sessionID) ?? []).some((work) => work.sessionID === sessionID)) {
      this.scheduleRecheck(sessionID)
      return
    }
    try {
      await this.options.send(sessionID)
    } catch (error) {
      this.options.onError(error, sessionID)
      return
    }
    task.sentCount += 1
    task.lastSentAt = this.options.now()
    this.emit(sessionID)
  }

  private async busy(sessionID: string): Promise<boolean> {
    try {
      return await this.options.isBusy(sessionID)
    } catch (error) {
      this.options.onError(error, sessionID)
      return true
    }
  }

  /** Records descendant-owned work for owners the registry has not seen idle yet. */
  private seedOwners(sessionID: string, background: readonly DeadLoopBackground[]): void {
    for (const work of background) {
      if (work.sessionID === sessionID) continue
      if (!this.backgrounds.has(work.sessionID)) this.backgrounds.set(work.sessionID, [work])
    }
  }

  private cancelTimers(sessionID: string): void {
    const quiet = this.quiet.get(sessionID)
    if (quiet !== undefined) {
      this.options.timers.clearTimeout(quiet)
      this.quiet.delete(sessionID)
    }
    const recheck = this.rechecks.get(sessionID)
    if (recheck !== undefined) {
      this.options.timers.clearTimeout(recheck)
      this.rechecks.delete(sessionID)
    }
  }

  private finish(sessionID: string, reason: DeadLoopOutcomeReason): void {
    const task = this.tasks.get(sessionID)
    this.cancelTimers(sessionID)
    this.tasks.delete(sessionID)
    this.outcomes.set(sessionID, {
      reason,
      at: this.options.now(),
      ...(task && task.sentCount > 0 ? { sentCount: task.sentCount } : {}),
      ...(task?.lastSentAt === undefined ? {} : { lastSentAt: task.lastSentAt }),
    })
    this.emit(sessionID)
  }

  private emit(sessionID: string): DeadLoopStatus {
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
