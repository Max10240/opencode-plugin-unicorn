# @max10240/opencode-plugin-notepad

**English** | [简体中文](README.zh-CN.md)

**A scratchpad that never interrupts the conversation.**

You are in the middle of a task and remember something: a follow-up, a bug to check, a command to try later. Typing it
into the chat competes with the agent's current instructions. Opening another app loses your flow. Dropping it in a
temporary file leaves it buried in the repository.

The notepad gives you a quick overlay for exactly these thoughts. It opens on top of the TUI, saves without disturbing
the session, and keeps notes organized by folder or across everything.

## When to use it

- You want to capture follow-ups while the agent is busy.
- You keep per-project reminders and want them to appear only in that project.
- You maintain a personal checklist that should follow you across every session.
- You need to copy a note back into the prompt without retyping it.
- You do not want your notes to become part of the model conversation.

## What you get

- **No interruption.** Open the notepad, write, close, and the agent never notices.
- **Folder-scoped notes by default.** Notes stay with the project they belong to.
- **Global notes when you need them.** Press `g` or `Ctrl+P` to share a note across every folder and session on the same
  OpenCode server.
- **Full editing.** Add, edit, delete, search, copy, pin, and move notes without leaving the overlay.
- **Recoverable deletion.** `Ctrl+Z` restores the last deleted note.
- **Private by default.** Notes are text you keep for yourself; they are never added to model context.

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
Notepad — /path/to/current/folder
/ Search...

This folder
  Follow up: review notepad storage
  folder · just now

Global
  Remember to check release notes
  global · 3m ago

a add · e edit · d delete · p pin · s sort: updated · c/ctrl+y copy · g/ctrl+p scope · tab search · ?/f1 help
```

| Key | Action |
| --- | --- |
| `a` | Add a note; it starts in the current folder |
| `e` | Edit the selected note; `f2` or `ctrl+s` saves, `esc` cancels |
| `d` | Delete the selected note after confirmation |
| `Ctrl+Z` | Restore the last deleted note for this folder |
| `p` | Pin or unpin the selected note; pinned notes stay at the top |
| `s` | Switch the sort order between last updated and created |
| `c` / `Ctrl+Y` | Copy the note text and show a confirmation |
| `g` / `Ctrl+P` | Move the note between the current folder and Global |
| `Tab` | Focus the search box; `Enter`, `Esc`, or `Tab` returns to the list |
| `↑` / `↓` | Select a note |
| `?` / `F1` | Show keyboard help |
| `Esc` | Close help or the notepad |

Use `F1` while the search box is focused; `?` works in the note list and is kept available for literal searches.

In the editor, `ctrl+g` or `ctrl+p` changes the save target between **This folder** and **Global**.

## How notes are organized

- **This folder** notes appear only in the exact folder where they were created. Different folders and worktrees do not
  see each other's notes.
- **Global** notes appear in every folder and session on the same OpenCode server.
- Notes are shared by all TUI clients connected to the same server, so your laptop and another client see the same
  data.
- Notes are stored as plain text with a scope, folder path, and timestamp. They never enter model context.
- Limits are generous but finite: 5000 notes per server, 100 KiB per note.

If you switch between loading the notepad standalone and through Unicorn, each mode keeps its own note store. Pick one
and stay with it.

## Configuration

| Option | Default | What it does |
| --- | --- | --- |
| `enabled` | `true` | Set to `false` to turn the notepad off |
| `keybind` | `ctrl+shift+n` | Change the shortcut; set to `false` to keep only the palette and `/notepad` entry |
| `defaultSort` | `updated` | Initial sort: `updated` or `created`; the last choice is remembered |
