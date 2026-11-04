# @max10240/opencode-plugin-notepad

**English** | [简体中文](README.zh-CN.md)

Capture quick notes without interrupting the current OpenCode conversation. Notes are grouped by the current folder by
default and can be shared globally across every session on the same OpenCode server.

## Usage

Standalone, load the package in both the server and TUI configuration:

```jsonc
// opencode.jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["@max10240/opencode-plugin-notepad"]
}
```

```json
// cli.json
{
  "$schema": "https://opencode.ai/v2/cli.json",
  "plugins": ["@max10240/opencode-plugin-notepad"]
}
```

With Unicorn, `features.notepad` is enabled by default:

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

## Opening

- Shortcut: `ctrl+shift+n`
- Command palette: search **Open notepad**
- Slash: `/notepad`

The command uses `mode: "global"` and `palette: true`, so it remains reachable while the palette or slash autocomplete
is active.

## Interaction

```text
Notepad — /path/to/current/folder
/ Search...

This folder
  Follow up: review notepad storage
  folder · just now

Global
  Remember to check release notes
  global · 3m ago

a add · e edit · d delete · c copy · g scope · tab search · esc close
```

- `a`: add a note; it defaults to the current folder.
- `e`: edit the selected note in a multiline editor. `f2` saves; `esc` cancels.
- `d`: delete after confirmation.
- `c`: copy the note text with OSC52 and show a toast.
- `g`: move the selected note between the current folder and Global.
- `Tab`: focus the search box; `Esc` or `Enter` returns to the list.
- `↑` / `↓`: select notes.
- `Esc`: close the notepad.

In the editor, `ctrl+g` changes the save target between **This folder** and **Global**.

## Scope and storage

- New notes default to `folder` scope and are visible only in the exact current directory.
- `global` notes are visible in every folder and session on the same server.
- Different folders and worktrees do not see each other's folder-scoped notes.
- Notes are stored by the server plugin and accessed by the TUI over RPC. Multiple TUI clients connected to the
  same plugin host share the same data. Standalone notepad and Unicorn use separate server storage namespaces, so
  choose one host mode consistently.
- Storage contains text, scope, folder path, and timestamps. It never enters model context.
- Limits: 5000 notes per server, 100 KiB per note.

## Configuration

- `enabled` defaults to `true`; set `false` to disable.
- `keybind` defaults to `ctrl+shift+n`; set `false` to remove the shortcut while keeping palette and slash access.

## Verification

```bash
bun run --cwd packages/opencode-plugin-notepad test
bun run check
```

Tests cover folder/global visibility, CRUD, validation, command registration, and a real isolated TUI flow for add,
scope change, copy, edit, delete, persistence, command palette, and slash.
