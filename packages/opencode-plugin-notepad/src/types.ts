export const MAX_NOTES = 5_000
export const MAX_NOTE_BYTES = 100 * 1024
export const STORED_VERSION = 1

export type NoteScope = "folder" | "global"

export type Note = {
  readonly id: string
  readonly text: string
  readonly scope: NoteScope
  readonly folder?: string
  readonly createdAt: number
  readonly updatedAt: number
}

export type NotesFile = {
  readonly version: typeof STORED_VERSION
  readonly notes: readonly Note[]
}
