import { randomUUID } from "node:crypto"
import path from "node:path"
import { MAX_NOTE_BYTES, MAX_NOTES, STORED_VERSION, type Note, type NoteScope, type NotesFile } from "./types.js"

export class NotepadError extends Error {}

type Load = () => Promise<unknown>
type Save = (value: NotesFile) => Promise<void>

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isScope(value: unknown): value is NoteScope {
  return value === "session" || value === "folder" || value === "global"
}

export function normalizeDirectory(value: string) {
  if (typeof value !== "string" || !value.trim()) throw new NotepadError("A folder is required")
  return path.resolve(value)
}

export function normalizeSession(value: unknown) {
  if (typeof value !== "string" || !value.trim()) throw new NotepadError("A session is required")
  return value.trim()
}

export function normalizeText(value: unknown) {
  if (typeof value !== "string") throw new NotepadError("Note text is required")
  const text = value.trim()
  if (!text) throw new NotepadError("Note text cannot be empty")
  if (Buffer.byteLength(text, "utf8") > MAX_NOTE_BYTES) throw new NotepadError(`Note text exceeds ${MAX_NOTE_BYTES} bytes`)
  return text
}

function storedNote(value: unknown): Note | undefined {
  if (!isRecord(value)) return
  if (typeof value.id !== "string" || !value.id) return
  if (typeof value.text !== "string" || !value.text.trim()) return
  if (!isScope(value.scope)) return
  if (value.scope === "folder" && (typeof value.folder !== "string" || !value.folder)) return
  if (value.scope === "session" && (typeof value.session !== "string" || !value.session)) return
  if (value.scope === "global" && (value.folder !== undefined || value.session !== undefined)) return
  if (typeof value.createdAt !== "number" || typeof value.updatedAt !== "number") return
  if (Buffer.byteLength(value.text, "utf8") > MAX_NOTE_BYTES) return
  return {
    id: value.id,
    text: value.text,
    scope: value.scope,
    ...(value.scope === "folder" ? { folder: value.folder as string } : {}),
    ...(value.scope === "session" ? { session: value.session as string } : {}),
    ...(value.pinned === true ? { pinned: true } : {}),
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  }
}

function parse(value: unknown): Note[] {
  if (value === undefined) return []
  if (!isRecord(value) || value.version !== STORED_VERSION || !Array.isArray(value.notes)) {
    throw new NotepadError("Notepad storage is invalid")
  }
  return value.notes.flatMap((item) => {
    const note = storedNote(item)
    return note ? [note] : []
  })
}

export function visibleNotes(notes: readonly Note[], directory: string, session?: string) {
  const folder = normalizeDirectory(directory)
  return notes
    .filter((note) =>
      note.scope === "global" ||
      (note.scope === "folder" && note.folder === folder) ||
      (note.scope === "session" && session !== undefined && note.session === session)
    )
    .slice()
    .sort((left, right) => Number(right.pinned === true) - Number(left.pinned === true) || right.updatedAt - left.updatedAt)
}

export class NoteStore {
  private queue: Promise<unknown> = Promise.resolve()

  constructor(
    private readonly load: Load,
    private readonly save: Save,
  ) {}

  private run<T>(operation: (notes: Note[]) => Promise<T> | T): Promise<T> {
    const next = this.queue.then(async () => {
      const notes = parse(await this.load())
      return operation(notes)
    })
    this.queue = next.catch(() => undefined)
    return next
  }

  private async persist(notes: Note[]) {
    await this.save({ version: STORED_VERSION, notes })
  }

  list(directory: string, session?: string) {
    return this.run((notes) => visibleNotes(notes, directory, session))
  }

  add(input: { text: unknown; scope: unknown; directory?: unknown; session?: unknown; pinned?: unknown }) {
    return this.run(async (notes) => {
      const text = normalizeText(input.text)
      const scope = isScope(input.scope)
        ? input.scope
        : input.session === undefined ? "folder" : "session"
      const folder = scope === "folder" ? normalizeDirectory(String(input.directory ?? "")) : undefined
      const session = scope === "session" ? normalizeSession(input.session) : undefined
      if (notes.length >= MAX_NOTES) throw new NotepadError(`Notepad cannot exceed ${MAX_NOTES} notes`)
      const now = Date.now()
      const note: Note = {
        id: randomUUID(),
        text,
        scope,
        ...(folder === undefined ? {} : { folder }),
        ...(session === undefined ? {} : { session }),
        ...(input.pinned === true ? { pinned: true } : {}),
        createdAt: now,
        updatedAt: now,
      }
      notes.push(note)
      await this.persist(notes)
      return note
    })
  }

  update(id: unknown, text: unknown) {
    return this.run(async (notes) => {
      if (typeof id !== "string" || !id) throw new NotepadError("A note id is required")
      const note = notes.find((item) => item.id === id)
      if (!note) throw new NotepadError("Note not found")
      const next: Note = { ...note, text: normalizeText(text), updatedAt: Date.now() }
      notes[notes.indexOf(note)] = next
      await this.persist(notes)
      return next
    })
  }

  remove(id: unknown) {
    return this.run(async (notes) => {
      if (typeof id !== "string" || !id) throw new NotepadError("A note id is required")
      const index = notes.findIndex((item) => item.id === id)
      if (index < 0) throw new NotepadError("Note not found")
      notes.splice(index, 1)
      await this.persist(notes)
    })
  }

  setPinned(id: unknown, pinned: unknown) {
    return this.run(async (notes) => {
      if (typeof id !== "string" || !id) throw new NotepadError("A note id is required")
      if (typeof pinned !== "boolean") throw new NotepadError("Invalid pin state")
      const note = notes.find((item) => item.id === id)
      if (!note) throw new NotepadError("Note not found")
      const { pinned: _previous, ...rest } = note
      const next: Note = {
        ...rest,
        ...(pinned ? { pinned: true } : {}),
        updatedAt: Date.now(),
      }
      notes[notes.indexOf(note)] = next
      await this.persist(notes)
      return next
    })
  }
}
