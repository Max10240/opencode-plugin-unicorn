# @max10240/opencode-plugin-notepad

**English** | [简体中文](README.zh-CN.md)

**A scratchpad that never interrupts the conversation.**

You are in the middle of a task and remember something: a follow-up, a bug to check, a command to try later. Typing it
into the chat competes with the agent's current instructions. Opening another app loses your flow. Dropping it in a
temporary file leaves it buried in the repository.

The notepad gives you a quick overlay for exactly these thoughts. It opens on top of the TUI, saves without disturbing
the session, and keeps notes organized by session, folder, or across everything.

## When to use it

- You want to capture follow-ups while the agent is busy.
- You want a note to stay in the session where you wrote it.
- You keep per-project reminders and want them to appear only in that project.
- You maintain a personal checklist that should follow you across every session.
- You need to copy a note back into the prompt without retyping it.
- You do not want your notes to become part of the model conversation unless you promote one to the session goal.

## What you get

- **No interruption.** Open the notepad, write, close, and the agent never notices.
- **Session-scoped notes by default.** Notes stay with the session they were written in.
- **Choose the scope with `Ctrl+A`.** Current Session, Current Directory, and Global change both what you browse and
  where a new note is saved.
- **Quick create.** Type in the create box and press `Enter`; there is no separate create panel.
- **Full editing.** Add, edit, delete, search, copy, and pin notes without leaving the overlay.
- **Session goals.** Press `Ctrl+T` to make the selected Current Session or Current Directory note the goal for this
  session. The goal is injected as session context, and changes are marked as superseding the previous goal.
- **Recoverable deletion.** `Ctrl+Z` restores the last deleted note. A goal note is protected until you clear the goal.
- **Private unless promoted.** Notes stay out of model context unless you explicitly set one as the session goal.

## Quick start

Standalone, load the package in both the server and TUI configuration:

```jsonc
// opencode.jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["@max10240/opencode-plugin-notepad"]
}
```

```jsonc
// cli.json
{
  "$schema": "https://opencode.ai/v2/cli.json",
  "plugins": ["@max10240/opencode-plugin-notepad"]
}
```

With Unicorn, the notepad is enabled by default:

```jsonc
{
  "plugins": [{
    "package": "@max10240/opencode-plugin-unicorn",
    "options": {
      "features": { "notepad": true },
      "notepad": { "keybind": "ctrl+shift+n" }
    }
  }]
}
```

## Opening it

- Press `ctrl+shift+n`.
- Search for **Open notepad** in the command palette.
- Type `/notepad`.

## Using it

```text
Notepad Current Session                                      f1 help · esc close
ctrl+a Show notes in Current Directory
/path/to/current/folder

Search in Current Session
New note in Current Session

🎯 Follow up: review notepad storage
  goal · session · just now
📌 Remember to check release notes
  pinned · session · 3m ago

ctrl+e edit · ctrl+d delete · ctrl+p pin · ctrl+t goal · ctrl+s sort: updated · ctrl+y copy · ↑/↓ select · tab search/create · f1 help
```

| Key | Action |
| --- | --- |
| `Enter` (create box) | Create the note in the current scope |
| `Shift+Enter` (create box) | Insert a new line in the note being written |
| `Ctrl+A` | Cycle the scope: Current Session → Current Directory → Global |
| `Ctrl+T` | Set the selected note as the session goal, or clear it when it is already the goal |
| `Ctrl+E` | Edit the selected note; `f2` or `ctrl+s` saves, `esc` cancels |
| `Ctrl+D` | Delete the selected note; press again to confirm. A goal note is protected |
| `Ctrl+Z` | Restore the last deleted note |
| `Ctrl+P` | Pin or unpin the selected note; pinned notes stay above unpinned notes |
| `Ctrl+S` | Switch the sort order between last updated and created |
| `Ctrl+Y` | Copy the note text and show a confirmation |
| `Tab` | Switch focus between the search box and the create box |
| `↑` / `↓` | Select a note; the first note is selected by default |
| `F1` | Show or close keyboard help |
| `Esc` | Close help or close the notepad |

The search and create placeholders always name the current scope. Switching scope keeps the text already typed in both
boxes. The header shows the current scope and the next scope `Ctrl+A` will display, and highlights that next scope; the
focused input has a highlighted bottom rule.

Notes keep the scope they were created in; there is no command to move a note between scopes.

## Session goals

- Press `Ctrl+T` on a **Current Session** or **Current Directory** note to make it the goal for this session. The
  shortcut is disabled in Global, where the footer hint is greyed out.
- A session has at most one goal. Setting another note replaces it, and clearing it with `Ctrl+T` returns the note to
  its normal position.
- The goal is stored as the `notepad.goal` session instruction entry. Every model request for that session sees it as
  system-level context, not as user-authored text.
- When the goal changes, OpenCode appends a system message saying the previous value is superseded. When it is cleared,
  it appends a message saying the context no longer applies. The goal is not duplicated into every user message.
- The goal note is marked `🎯`, pinned notes use `📌`, and the goal always sorts first. It stays visible when the search
  query or the current scope would otherwise hide it.
- Setting a note longer than 8 KiB as the goal is rejected. Editing the goal note updates the goal text; if the edited text
  exceeds 8 KiB, the goal is cleared with a warning.
- The goal note cannot be deleted until the goal is cleared with `Ctrl+T`.
- Only the goal text enters model context. Every other note stays private.

## How notes are organized

- **Current Session** notes appear only in the session where they were created, even when another session uses the same
  folder.
- **Current Directory** notes appear in every session that uses the exact same folder. Different folders and worktrees
  do not see each other's notes.
- **Global** notes appear in every folder and session on the same OpenCode server.
- Notes are shared by all TUI clients connected to the same server, so your laptop and another client see the same
  data.
- Notes are stored as plain text with a scope, session id or folder path, and timestamp. They do not enter model context
  unless one is set as the session goal.
- Limits are generous but finite: 5000 notes per server, 100 KiB per note, 8 KiB per goal.

If you switch between loading the notepad standalone and through Unicorn, each mode keeps its own note store. Pick one
and stay with it.

## Configuration

| Option | Default | What it does |
| --- | --- | --- |
| `enabled` | `true` | Set to `false` to turn the notepad off |
| `keybind` | `ctrl+shift+n` | Change the shortcut; set to `false` to keep only the palette and `/notepad` entry |
| `defaultSort` | `updated` | Initial sort: `updated` or `created`; the last choice is remembered |
