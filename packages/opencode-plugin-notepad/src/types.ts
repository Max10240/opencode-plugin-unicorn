export const MAX_NOTES = 5_000
export const MAX_NOTE_BYTES = 100 * 1024
export const MAX_GOAL_BYTES = 8 * 1024
export const STORED_VERSION = 1

export type NoteScope = "session" | "folder" | "global"

export type Note = {
  readonly id: string
  readonly text: string
  readonly scope: NoteScope
  readonly folder?: string
  readonly session?: string
  readonly pinned?: boolean
  readonly createdAt: number
  readonly updatedAt: number
}

export type NotesFile = {
  readonly version: typeof STORED_VERSION
  readonly notes: readonly Note[]
}

export type Goal = {
  readonly noteID: string
  readonly text: string
  readonly scope: "session" | "folder"
  readonly folder?: string
  readonly session?: string
  readonly updatedAt: number
}

export type GoalsFile = {
  readonly version: typeof STORED_VERSION
  readonly goals: Readonly<Record<string, Goal>>
}
