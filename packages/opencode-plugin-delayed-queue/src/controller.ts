import type { WaitKind } from "./options.js"

export type DelayedQueueItem = {
  readonly id: string
  readonly text: string
  readonly createdAt: number
}

export type PauseReason = "interrupted" | "failed" | "restart" | "manual" | "delivery"

export type DelayedQueueBackground = {
  readonly kind: string
  readonly sessionID: string
  readonly label?: string
  readonly jobID?: string
  readonly shellID?: string
  readonly command?: string
  readonly childSessionID?: string
  readonly agent?: string
  readonly description?: string
  readonly path?: string
  readonly model?: string
}

export type DelayedQueueJob = {
  readonly id: string
  readonly kind: string
  readonly sessionID: string
  readonly status: string
  readonly childSessionID?: string
  readonly shellID?: string
  readonly command?: string
  readonly description?: string
  readonly title?: string
  readonly path?: string
}

export type DelayedQueueStatus = {
  readonly sessionID: string
  readonly paused: boolean
  readonly pauseReason?: PauseReason
  readonly items: readonly DelayedQueueItem[]
  readonly waitingFor: readonly DelayedQueueBackground[]
  readonly observed: boolean
  readonly delivering: boolean
  readonly lastError?: string
  readonly updatedAt: number
}

export type PersistedDelayedQueue = {
  readonly version: 1
  readonly boot: string
  readonly paused: boolean
  readonly pauseReason?: PauseReason
  readonly items: readonly DelayedQueueItem[]
  readonly updatedAt: number
}

export type DelayedQueueTimers = {
  setTimeout(run: () => void, delay: number): unknown
  clearTimeout(timer: unknown): void
}

export type DelayedQueueControllerOptions = {
  readonly boot: string
  readonly recheckMs: number
  readonly waitKinds: readonly WaitKind[]
  readonly waitDescendants: boolean
  readonly pauseOnInterrupt: boolean
  readonly pauseOnFailure: boolean
  readonly now: () => number
  readonly timers?: DelayedQueueTimers
  readonly isBusy: (sessionID: string) => Promise<boolean>
  readonly parentOf: (sessionID: string) => Promise<string | undefined>
  readonly deliver: (sessionID: string, item: DelayedQueueItem) => Promise<void>
  readonly save: (sessionID: string, state: PersistedDelayedQueue) => Promise<void>
  readonly onChange: (status: DelayedQueueStatus) => void
  readonly onError: (error: unknown, sessionID: string) => void
}

type State = {
  readonly sessionID: string
  boot: string
  paused: boolean
  pauseReason?: PauseReason
  items: DelayedQueueItem[]
  updatedAt: number
  background?: readonly DelayedQueueBackground[]
  observed: boolean
  delivering: boolean
  failures: number
  lastError?: string
  resumePending: boolean
}

const MAX_DELIVERY_FAILURES = 3

/**
 * Owns the delayed queue per Session. The runner's `experimental.idle` hook is the
 * authoritative boundary; the controller never waits inside that hook. It either
 * admits the next item, or returns and lets a wake or a recheck run again.
 */
export class DelayedQueueController {
  private readonly states = new Map<string, State>()
  private readonly jobs = new Map<string, DelayedQueueJob>()
  private readonly timers = new Map<string, unknown>()
  private readonly locks = new Map<string, Promise<unknown>>()
  private readonly parents = new Map<string, string | null>()
  private readonly now: () => number
  private readonly scheduleTimer: (run: () => void, delay: number) => unknown
  private readonly cancelTimer: (timer: unknown) => void
  private readonly waitKinds: Set<WaitKind>
  private disposed = false

  constructor(private readonly options: DelayedQueueControllerOptions) {
    this.now = options.now
    this.scheduleTimer = options.timers?.setTimeout ?? ((run, delay) => setTimeout(run, delay))
    this.cancelTimer =
      options.timers?.clearTimeout ?? ((timer) => clearTimeout(timer as ReturnType<typeof setTimeout>))
    this.waitKinds = new Set(options.waitKinds)
  }

  hydrate(sessionID: string, stored: PersistedDelayedQueue): void {
    if (this.disposed) return
    const paused = stored.boot !== this.options.boot ? true : stored.paused
    const pauseReason = stored.boot !== this.options.boot ? "restart" : paused ? stored.pauseReason : undefined
    this.states.set(sessionID, {
      sessionID,
      boot: this.options.boot,
      paused,
      ...(pauseReason === undefined ? {} : { pauseReason }),
      items: stored.items.map((item) => ({ id: item.id, text: item.text, createdAt: item.createdAt })),
      updatedAt: stored.updatedAt,
      observed: false,
      delivering: false,
      failures: 0,
      resumePending: false,
    })
  }

  status(sessionID: string): DelayedQueueStatus {
    const state = this.states.get(sessionID)
    if (!state) return this.emptyStatus(sessionID)
    return this.snapshot(state)
  }

  async enqueue(
    sessionID: string,
    text: string,
    jobs?: readonly DelayedQueueJob[],
  ): Promise<DelayedQueueStatus> {
    return this.withLock(sessionID, async () => {
      const state = this.state(sessionID)
      const value = text.trim()
      if (!value) return this.snapshot(state)
      state.items.push({ id: messageID(this.now()), text: value, createdAt: this.now() })
      state.updatedAt = this.now()
      if (jobs !== undefined) {
        state.observed = true
        await this.replaceJobs(sessionID, jobs)
      }
      await this.changed(state)
      await this.kickLocked(state)
      return this.snapshot(state)
    })
  }

  async syncJobs(sessionID: string, jobs: readonly DelayedQueueJob[]): Promise<DelayedQueueStatus> {
    return this.withLock(sessionID, async () => {
      const state = this.state(sessionID)
      const first = !state.observed
      state.observed = true
      state.updatedAt = this.now()
      await this.replaceJobs(sessionID, jobs)
      if (first) await this.changed(state)
      else this.options.onChange(this.snapshot(state))
      await this.kickLocked(state)
      return this.snapshot(state)
    })
  }

  async remove(sessionID: string, ids: readonly string[]): Promise<DelayedQueueStatus> {
    return this.withLock(sessionID, async () => {
      const state = this.states.get(sessionID)
      if (!state) return this.emptyStatus(sessionID)
      const drop = new Set(ids)
      state.items = state.items.filter((item) => !drop.has(item.id))
      state.updatedAt = this.now()
      if (state.items.length === 0) this.cancelRecheck(sessionID)
      await this.changed(state)
      return this.snapshot(state)
    })
  }

  async clear(sessionID: string): Promise<DelayedQueueStatus> {
    return this.withLock(sessionID, async () => {
      const state = this.states.get(sessionID)
      if (!state) return this.emptyStatus(sessionID)
      state.items = []
      state.updatedAt = this.now()
      this.cancelRecheck(sessionID)
      await this.changed(state)
      return this.snapshot(state)
    })
  }

  async pause(sessionID: string, reason: PauseReason): Promise<DelayedQueueStatus> {
    return this.withLock(sessionID, async () => {
      const state = this.state(sessionID)
      state.paused = true
      state.pauseReason = reason
      state.resumePending = false
      state.updatedAt = this.now()
      this.cancelRecheck(sessionID)
      await this.changed(state)
      return this.snapshot(state)
    })
  }

  async resume(sessionID: string): Promise<DelayedQueueStatus> {
    return this.withLock(sessionID, async () => {
      const state = this.state(sessionID)
      state.paused = false
      state.pauseReason = undefined
      state.failures = 0
      state.lastError = undefined
      state.resumePending = false
      state.observed = true
      state.updatedAt = this.now()
      await this.changed(state)
      await this.kickLocked(state)
      return this.snapshot(state)
    })
  }

  async deliverNow(sessionID: string, id: string): Promise<DelayedQueueStatus> {
    return this.withLock(sessionID, async () => {
      const state = this.states.get(sessionID)
      if (!state) return this.emptyStatus(sessionID)
      const item = state.items.find((entry) => entry.id === id)
      if (!item || state.delivering) return this.snapshot(state)
      await this.deliverLocked(state, item, true)
      return this.snapshot(state)
    })
  }

  /** Runs at the runner's idle boundary. Never awaits background work. */
  async onIdle(sessionID: string, background: readonly DelayedQueueBackground[]): Promise<void> {
    await this.withLock(sessionID, async () => {
      const state = this.state(sessionID)
      state.observed = true
      state.background = background.map((work) => ({ ...work }))
      state.updatedAt = this.now()
      this.cancelRecheck(sessionID)
      this.releasePromptPause(state)
      for (const other of this.states.values()) {
        if (other.sessionID === sessionID || other.items.length === 0 || other.paused) continue
        this.scheduleRecheck(other.sessionID)
      }
      if (state.paused || state.items.length === 0 || state.delivering) {
        await this.changed(state)
        return
      }
      const relevant = this.relevantBackground(state, background)
      if (relevant.some((work) => work.sessionID === sessionID)) {
        // The Session's own work normally wakes it. A recheck covers a missed notice, a
        // recovered notice admitted with resume:false, and a client that reconnects late.
        await this.changed(state)
        this.scheduleRecheck(sessionID)
        return
      }
      if (relevant.length > 0) {
        // Descendant-owned work wakes that descendant, not this Session. Recheck.
        await this.changed(state)
        this.scheduleRecheck(sessionID)
        return
      }
      await this.deliverLocked(state, state.items[0]!, true)
    })
  }

  /**
   * A non-plugin prompt releases an interrupt/failure pause once its execution actually starts,
   * or at the next idle boundary for a prompt steered into a running turn. Releasing on prompt
   * admission would let a recheck deliver ahead of a turn that has not started yet, merging the
   * delayed message into the user's turn.
   */
  async onPrompt(sessionID: string, own: boolean): Promise<void> {
    if (own) return
    await this.withLock(sessionID, async () => {
      const state = this.states.get(sessionID)
      if (!state || !state.paused) return
      if (state.pauseReason !== "interrupted" && state.pauseReason !== "failed") return
      state.resumePending = true
    })
  }

  async onExecutionInterrupted(sessionID: string, reason: string): Promise<void> {
    if (reason === "user" && this.options.pauseOnInterrupt) {
      await this.pauseIfWaiting(sessionID, "interrupted")
      return
    }
    if (reason === "shutdown") await this.pauseIfWaiting(sessionID, "restart")
  }

  async onExecutionFailed(sessionID: string): Promise<void> {
    if (this.options.pauseOnFailure) await this.pauseIfWaiting(sessionID, "failed")
  }

  private async pauseIfWaiting(sessionID: string, reason: PauseReason): Promise<void> {
    const state = this.states.get(sessionID)
    if (!state || state.items.length === 0) return
    await this.pause(sessionID, reason)
  }

  async onExecutionStarted(sessionID: string): Promise<void> {
    await this.withLock(sessionID, async () => {
      this.cancelRecheck(sessionID)
      const state = this.states.get(sessionID)
      if (!state?.resumePending) return
      state.resumePending = false
      if (!state.paused) return
      state.paused = false
      state.pauseReason = undefined
      state.failures = 0
      state.lastError = undefined
      state.updatedAt = this.now()
      await this.changed(state)
    })
  }

  private releasePromptPause(state: State): void {
    if (!state.resumePending) return
    state.resumePending = false
    if (!state.paused) return
    state.paused = false
    state.pauseReason = undefined
    state.failures = 0
    state.lastError = undefined
    state.updatedAt = this.now()
  }

  onJob(info: DelayedQueueJob): void {
    if (this.disposed) return
    if (info.status === "running") this.jobs.set(info.id, { ...info })
    else this.jobs.delete(info.id)
    for (const state of this.states.values()) {
      if (state.items.length === 0) continue
      state.observed = true
      if (!state.paused) this.scheduleRecheck(state.sessionID)
    }
    for (const state of this.states.values()) this.options.onChange(this.snapshot(state))
  }

  async onSessionDeleted(sessionID: string): Promise<void> {
    await this.withLock(sessionID, async () => {
      this.cancelRecheck(sessionID)
      this.states.delete(sessionID)
      for (const [id, job] of this.jobs) {
        if (job.sessionID === sessionID || job.childSessionID === sessionID) this.jobs.delete(id)
      }
      this.parents.delete(sessionID)
    })
  }

  private async replaceJobs(sessionID: string, jobs: readonly DelayedQueueJob[]): Promise<void> {
    for (const [id, job] of this.jobs) {
      if (job.sessionID === sessionID || job.childSessionID === sessionID) {
        this.jobs.delete(id)
        continue
      }
      if (!this.options.waitDescendants) continue
      if (
        (await this.isDescendant(job.sessionID, sessionID)) ||
        (job.childSessionID !== undefined && (await this.isDescendant(job.childSessionID, sessionID)))
      )
        this.jobs.delete(id)
    }
    this.seedJobs(sessionID, jobs)
  }

  seedJobs(sessionID: string, jobs: readonly DelayedQueueJob[]): void {
    const state = this.states.get(sessionID)
    if (state) state.observed = true
    for (const job of jobs) {
      if (job.status === "running") this.jobs.set(job.id, { ...job })
      else this.jobs.delete(job.id)
    }
  }

  dispose(): void {
    this.disposed = true
    for (const sessionID of this.timers.keys()) this.cancelRecheck(sessionID)
    this.states.clear()
    this.jobs.clear()
    this.parents.clear()
  }

  private state(sessionID: string): State {
    const existing = this.states.get(sessionID)
    if (existing) return existing
    const created: State = {
      sessionID,
      boot: this.options.boot,
      paused: false,
      items: [],
      updatedAt: this.now(),
      observed: false,
      delivering: false,
      failures: 0,
      resumePending: false,
    }
    this.states.set(sessionID, created)
    return created
  }

  private emptyStatus(sessionID: string): DelayedQueueStatus {
    return {
      sessionID,
      paused: false,
      items: [],
      waitingFor: [],
      observed: false,
      delivering: false,
      updatedAt: this.now(),
    }
  }

  private snapshot(state: State): DelayedQueueStatus {
    return {
      sessionID: state.sessionID,
      paused: state.paused,
      ...(state.pauseReason === undefined ? {} : { pauseReason: state.pauseReason }),
      items: state.items.map((item) => ({ ...item })),
      waitingFor: this.waitingFor(state),
      observed: state.observed,
      delivering: state.delivering,
      ...(state.lastError === undefined ? {} : { lastError: state.lastError }),
      updatedAt: state.updatedAt,
    }
  }

  private waitingFor(state: State): readonly DelayedQueueBackground[] {
    const jobs = [...this.jobs.values()].filter(
      (job) => job.status === "running" && this.waitKinds.has(job.kind as WaitKind),
    )
    const relevant = jobs.filter(
      (job) =>
        job.sessionID === state.sessionID ||
        (this.options.waitDescendants && this.knownDescendant(job.sessionID, state.sessionID)),
    )
    if (relevant.length > 0) {
      return relevant.map((job) => ({
        kind: job.kind,
        sessionID: job.sessionID,
        ...(jobLabel(job) === undefined ? {} : { label: jobLabel(job) }),
        jobID: job.id,
        ...(job.shellID === undefined ? {} : { shellID: job.shellID }),
        ...(job.command === undefined ? {} : { command: job.command }),
        ...(job.childSessionID === undefined ? {} : { childSessionID: job.childSessionID }),
        ...(job.description === undefined ? {} : { description: job.description }),
        ...(job.path === undefined ? {} : { path: job.path }),
      }))
    }
    return state.background === undefined ? [] : this.relevantBackground(state, state.background)
  }

  /** Snapshot-only descendant test. Deep parent chains refresh through `isDescendant`. */
  private knownDescendant(owner: string, ancestor: string): boolean {
    let current = this.parents.get(owner)
    if (current === undefined) return false
    const seen = new Set<string>()
    while (current !== null && !seen.has(current)) {
      if (current === ancestor) return true
      seen.add(current)
      current = this.parents.get(current) ?? null
    }
    return false
  }

  private relevantBackground(
    state: State,
    background: readonly DelayedQueueBackground[],
  ): readonly DelayedQueueBackground[] {
    return background.filter((work) => {
      if (!this.waitKinds.has(work.kind as WaitKind)) return false
      if (work.sessionID === state.sessionID) return true
      return this.options.waitDescendants
    })
  }

  private async kickLocked(state: State): Promise<void> {
    if (this.disposed || state.paused || state.items.length === 0 || state.delivering) return
    if (await this.safeBusy(state.sessionID)) {
      this.scheduleRecheck(state.sessionID)
      return
    }
    if (await this.hasRelevantJobs(state.sessionID) || (await this.backgroundBlocks(state))) {
      this.scheduleRecheck(state.sessionID)
      return
    }
    if (!state.observed) {
      this.scheduleRecheck(state.sessionID)
      return
    }
    await this.deliverLocked(state, state.items[0]!)
  }

  private async deliverLocked(state: State, item: DelayedQueueItem, atIdle = false): Promise<void> {
    if (this.disposed || state.delivering) return
    if (!atIdle && (await this.safeBusy(state.sessionID))) {
      this.scheduleRecheck(state.sessionID)
      return
    }
    state.delivering = true
    try {
      await this.options.deliver(state.sessionID, item)
      state.items = state.items.filter((entry) => entry.id !== item.id)
      state.failures = 0
      state.lastError = undefined
      state.updatedAt = this.now()
      await this.changed(state)
    } catch (error) {
      state.failures += 1
      state.lastError = error instanceof Error ? error.message : String(error)
      state.updatedAt = this.now()
      this.options.onError(error, state.sessionID)
      if (state.failures >= MAX_DELIVERY_FAILURES) {
        state.paused = true
        state.pauseReason = "delivery"
      } else {
        this.scheduleRecheck(state.sessionID)
      }
      await this.changed(state)
    } finally {
      state.delivering = false
    }
  }

  private scheduleRecheck(sessionID: string): void {
    if (this.disposed || this.timers.has(sessionID)) return
    const handle = this.scheduleTimer(() => {
      this.timers.delete(sessionID)
      void this.recheck(sessionID)
    }, this.options.recheckMs)
    this.timers.set(sessionID, handle)
  }

  private cancelRecheck(sessionID: string): void {
    const handle = this.timers.get(sessionID)
    if (handle === undefined) return
    this.cancelTimer(handle)
    this.timers.delete(sessionID)
  }

  private async recheck(sessionID: string): Promise<void> {
    await this.withLock(sessionID, async () => {
      const state = this.states.get(sessionID)
      if (this.disposed || !state || state.paused || state.items.length === 0 || state.delivering) return
      if (await this.safeBusy(sessionID)) {
        this.scheduleRecheck(sessionID)
        return
      }
      if (await this.hasRelevantJobs(sessionID)) {
        this.scheduleRecheck(sessionID)
        return
      }
      const background = state.background
      if (background) {
        for (const work of this.relevantBackground(state, background)) {
          if (work.sessionID === sessionID) {
            // Own work wakes this Session and re-runs the idle hook. A recheck must not
            // deliver ahead of that wake while the snapshot still lists it.
            if (await this.jobRunning(work)) {
              this.scheduleRecheck(sessionID)
              return
            }
            continue
          }
          const owner = this.states.get(work.sessionID)
          if (owner?.background === undefined || owner.background.length > 0) {
            this.scheduleRecheck(sessionID)
            return
          }
          if (await this.safeBusy(work.sessionID)) {
            this.scheduleRecheck(sessionID)
            return
          }
        }
      }
      // No idle hook has run for this Session yet. If no watched job is running and
      // the Session is idle, the recheck is the confirmation and delivery can proceed.
      await this.deliverLocked(state, state.items[0]!)
    })
  }

  private async hasRelevantJobs(sessionID: string): Promise<boolean> {
    for (const job of this.jobs.values()) {
      if (job.status !== "running" || !this.waitKinds.has(job.kind as WaitKind)) continue
      if (job.sessionID === sessionID) return true
      if (!this.options.waitDescendants) continue
      if (await this.isDescendant(job.sessionID, sessionID)) return true
      if (job.childSessionID && (await this.isDescendant(job.childSessionID, sessionID))) return true
    }
    return false
  }

  private async jobRunning(work: DelayedQueueBackground): Promise<boolean> {
    for (const job of this.jobs.values()) {
      if (job.status !== "running" || job.kind !== work.kind) continue
      if (work.kind === "shell" && job.shellID === work.shellID) return true
      if (work.kind === "subagent" && job.childSessionID === work.childSessionID) return true
      if ((work.kind === "image" || work.kind === "video") && job.path === work.path) return true
      if (work.kind === "codemode" && job.id === work.jobID) return true
    }
    return false
  }

  private async backgroundBlocks(state: State): Promise<boolean> {
    if (!state.background) return false
    for (const work of this.relevantBackground(state, state.background)) {
      if (work.sessionID === state.sessionID) return true
      const owner = this.states.get(work.sessionID)
      if (owner?.background === undefined || owner.background.length > 0) return true
      if (await this.safeBusy(work.sessionID)) return true
    }
    return false
  }

  private async isDescendant(owner: string, ancestor: string): Promise<boolean> {
    if (owner === ancestor) return true
    const seen = new Set<string>()
    let current: string | undefined = owner
    while (current !== undefined && !seen.has(current)) {
      if (current === ancestor) return true
      seen.add(current)
      const cached = this.parents.get(current)
      if (cached !== undefined) {
        current = cached ?? undefined
        continue
      }
      try {
        const parent = await this.options.parentOf(current)
        this.parents.set(current, parent ?? null)
        current = parent
      } catch (error) {
        this.options.onError(error, owner)
        return false
      }
    }
    return false
  }

  private async safeBusy(sessionID: string): Promise<boolean> {
    try {
      return await this.options.isBusy(sessionID)
    } catch (error) {
      this.options.onError(error, sessionID)
      return true
    }
  }

  private async changed(state: State): Promise<void> {
    const persisted: PersistedDelayedQueue = {
      version: 1,
      boot: state.boot,
      paused: state.paused,
      ...(state.pauseReason === undefined ? {} : { pauseReason: state.pauseReason }),
      items: state.items.map((item) => ({ ...item })),
      updatedAt: state.updatedAt,
    }
    try {
      await this.options.save(state.sessionID, persisted)
    } catch (error) {
      this.options.onError(error, state.sessionID)
    }
    this.options.onChange(this.snapshot(state))
  }

  private async withLock<T>(sessionID: string, run: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(sessionID) ?? Promise.resolve()
    const next = previous.then(run, run)
    this.locks.set(sessionID, next)
    const cleanup = () => {
      if (this.locks.get(sessionID) === next) this.locks.delete(sessionID)
    }
    void next.then(cleanup, cleanup)
    return next
  }
}

function messageID(now: number): string {
  const time = now.toString(16).padStart(12, "0")
  const random = crypto.randomUUID().replaceAll("-", "").slice(0, 14)
  return `msg_${time}${random}`
}

function jobLabel(job: DelayedQueueJob): string | undefined {
  if (job.kind === "shell") return job.command
  if (job.kind === "subagent") return job.description ?? job.title
  if (job.kind === "image" || job.kind === "video") return job.path
  if (job.kind === "codemode") return "Code Mode script"
  return job.title
}
