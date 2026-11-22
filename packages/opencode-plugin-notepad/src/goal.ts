import { NotepadError, normalizeDirectory } from "./store.js"
import { MAX_GOAL_BYTES, STORED_VERSION, type Goal, type GoalsFile, type Note } from "./types.js"

export const GOAL_INSTRUCTION_KEY = "notepad.goal"

type Load = () => Promise<unknown>
type Save = (value: GoalsFile) => Promise<void>

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function storedGoal(value: unknown): Goal | undefined {
  if (!isRecord(value)) return
  if (typeof value.noteID !== "string" || !value.noteID) return
  if (typeof value.text !== "string" || !value.text.trim()) return
  if (value.scope !== "session" && value.scope !== "folder") return
  if (value.scope === "session" && (typeof value.session !== "string" || !value.session)) return
  if (value.scope === "folder" && (typeof value.folder !== "string" || !value.folder)) return
  if (typeof value.updatedAt !== "number") return
  if (Buffer.byteLength(value.text, "utf8") > MAX_GOAL_BYTES) return
  return {
    noteID: value.noteID,
    text: value.text,
    scope: value.scope,
    ...(value.scope === "session" ? { session: value.session as string } : {}),
    ...(value.scope === "folder" ? { folder: value.folder as string } : {}),
    updatedAt: value.updatedAt,
  }
}

function parse(value: unknown): Record<string, Goal> {
  if (value === undefined) return {}
  if (!isRecord(value) || value.version !== STORED_VERSION || !isRecord(value.goals)) {
    throw new NotepadError("Notepad goals are invalid")
  }
  const goals: Record<string, Goal> = {}
  for (const [sessionID, raw] of Object.entries(value.goals)) {
    if (!sessionID.trim()) continue
    const goal = storedGoal(raw)
    if (goal) goals[sessionID] = goal
  }
  return goals
}

export function goalInstruction(text: string) {
  return `Session goal (set from the notepad):\n${text}`
}

export class GoalStore {
  private queue: Promise<unknown> = Promise.resolve()

  constructor(
    private readonly load: Load,
    private readonly save: Save,
  ) {}

  private run<T>(operation: (goals: Record<string, Goal>) => Promise<T> | T): Promise<T> {
    const next = this.queue.then(async () => {
      const goals = parse(await this.load())
      return operation(goals)
    })
    this.queue = next.catch(() => undefined)
    return next
  }

  private async persist(goals: Record<string, Goal>) {
    await this.save({ version: STORED_VERSION, goals })
  }

  get(sessionID: string) {
    return this.run((goals) => goals[sessionID])
  }

  set(sessionID: string, note: Note, directory: string) {
    return this.run(async (goals) => {
      if (!sessionID.trim()) throw new NotepadError("A session is required")
      if (note.scope === "global") throw new NotepadError("Global notes cannot be a session goal")
      if (note.scope === "session" && note.session !== sessionID) {
        throw new NotepadError("The note belongs to another session")
      }
      if (note.scope === "folder" && note.folder !== normalizeDirectory(directory)) {
        throw new NotepadError("The note is not in the current directory")
      }
      if (Buffer.byteLength(note.text, "utf8") > MAX_GOAL_BYTES) {
        throw new NotepadError(`Goal cannot exceed ${MAX_GOAL_BYTES} bytes`)
      }
      const goal: Goal = {
        noteID: note.id,
        text: note.text,
        scope: note.scope,
        ...(note.scope === "session" ? { session: note.session as string } : {}),
        ...(note.scope === "folder" ? { folder: note.folder as string } : {}),
        updatedAt: Date.now(),
      }
      goals[sessionID] = goal
      await this.persist(goals)
      return goal
    })
  }

  restore(sessionID: string, goal: Goal) {
    return this.run(async (goals) => {
      goals[sessionID] = goal
      await this.persist(goals)
    })
  }

  clear(sessionID: string) {
    return this.run(async (goals) => {
      const previous = goals[sessionID]
      if (previous === undefined) return
      delete goals[sessionID]
      await this.persist(goals)
      return previous
    })
  }

  updateNote(note: Note) {
    return this.run(async (goals) => {
      const updated: Array<{ sessionID: string; goal: Goal }> = []
      const cleared: string[] = []
      let changed = false
      for (const [sessionID, goal] of Object.entries(goals)) {
        if (goal.noteID !== note.id) continue
        if (Buffer.byteLength(note.text, "utf8") > MAX_GOAL_BYTES) {
          delete goals[sessionID]
          cleared.push(sessionID)
          changed = true
          continue
        }
        if (goal.text === note.text) continue
        const next: Goal = {
          noteID: goal.noteID,
          text: note.text,
          scope: goal.scope,
          ...(goal.session === undefined ? {} : { session: goal.session }),
          ...(goal.folder === undefined ? {} : { folder: goal.folder }),
          updatedAt: note.updatedAt,
        }
        goals[sessionID] = next
        updated.push({ sessionID, goal: next })
        changed = true
      }
      if (changed) await this.persist(goals)
      return { updated, cleared }
    })
  }

  references(noteID: string) {
    return this.run((goals) =>
      Object.entries(goals)
        .filter(([, goal]) => goal.noteID === noteID)
        .map(([sessionID]) => sessionID)
    )
  }

  removeNote(noteID: string) {
    return this.run(async (goals) => {
      const cleared: string[] = []
      for (const [sessionID, goal] of Object.entries(goals)) {
        if (goal.noteID !== noteID) continue
        delete goals[sessionID]
        cleared.push(sessionID)
      }
      if (cleared.length > 0) await this.persist(goals)
      return cleared
    })
  }
}
