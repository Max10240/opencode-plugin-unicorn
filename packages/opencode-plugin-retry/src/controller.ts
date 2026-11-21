import { DEFAULT_INTERRUPT_TIMEOUT_MS } from "./options.js"

export type RetrySessionStatus = "idle" | "running"
export type RetryInterruptResult = { readonly interrupted: boolean }
export type RetryFailure = "status" | "interrupt" | "timeout" | "wait" | "send"
export type RetryOutcome =
  | { readonly status: "ignored" }
  | { readonly status: "sent"; readonly interrupted: boolean }
  | { readonly status: "failed"; readonly reason: RetryFailure }

export type RetryControllerOptions = {
  readonly continueText: string
  readonly timeoutMs?: number
  readonly status: (sessionID: string) => RetrySessionStatus
  readonly interrupt: (sessionID: string) => Promise<RetryInterruptResult>
  readonly waitIdle: (sessionID: string, signal: AbortSignal) => Promise<void>
  readonly send: (sessionID: string, text: string) => Promise<void>
  readonly onError: (message: string) => void
  readonly onSent?: (interrupted: boolean) => void
  readonly createTimeoutSignal?: (timeoutMs: number) => AbortSignal
}

export class RetryController {
  private readonly inFlight = new Set<string>()
  private readonly timeoutMs: number
  private readonly createTimeoutSignal: (timeoutMs: number) => AbortSignal
  private disposed = false

  constructor(private readonly options: RetryControllerOptions) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_INTERRUPT_TIMEOUT_MS
    this.createTimeoutSignal = options.createTimeoutSignal ?? ((timeoutMs) => AbortSignal.timeout(timeoutMs))
  }

  async run(sessionID: string): Promise<RetryOutcome> {
    if (this.disposed || this.inFlight.has(sessionID)) return { status: "ignored" }
    this.inFlight.add(sessionID)
    try {
      let running: boolean
      try {
        running = this.options.status(sessionID) === "running"
      } catch {
        return this.fail("status", "Retry failed: could not read the session state")
      }

      if (!running) {
        const sent = await this.send(sessionID, false)
        return sent
      }

      let interrupted: boolean
      try {
        interrupted = (await this.options.interrupt(sessionID)).interrupted
      } catch {
        return this.fail("interrupt", "Retry failed: could not interrupt the current turn")
      }

      let needsWait = interrupted
      if (!needsWait) {
        // `false` also covers an execution that is already stopping. Only treat it as idle when the
        // session really is idle; otherwise wait for settlement before sending Continue.
        try {
          needsWait = this.options.status(sessionID) === "running"
        } catch {
          return this.fail("status", "Retry failed: could not read the session state")
        }
      }

      if (needsWait) {
        const signal = this.createTimeoutSignal(this.timeoutMs)
        try {
          await this.options.waitIdle(sessionID, signal)
        } catch {
          const seconds = Math.ceil(this.timeoutMs / 1_000)
          return this.fail(
            signal.aborted ? "timeout" : "wait",
            signal.aborted
              ? `Retry failed: the current turn did not stop within ${seconds} ${seconds === 1 ? "second" : "seconds"}`
              : "Retry failed: could not finish interrupting the current turn",
          )
        }
      }

      if (this.disposed) return { status: "ignored" }
      return this.send(sessionID, interrupted)
    } finally {
      this.inFlight.delete(sessionID)
    }
  }

  dispose(): void {
    this.disposed = true
  }

  private async send(sessionID: string, interrupted: boolean): Promise<RetryOutcome> {
    if (this.disposed) return { status: "ignored" }
    try {
      await this.options.send(sessionID, this.options.continueText)
      this.options.onSent?.(interrupted)
      return { status: "sent", interrupted }
    } catch {
      return this.fail("send", "Retry failed: could not send Continue")
    }
  }

  private fail(reason: RetryFailure, message: string): RetryOutcome {
    this.options.onError(message)
    return { status: "failed", reason }
  }
}
