# @max10240/opencode-plugin-prompt-search

**English** | [简体中文](README.zh-CN.md)

**Stop retyping prompts you have already written.**

Over a few weeks, OpenCode accumulates hundreds of prompts: a review checklist, a debugging brief, a migration plan, a
carefully worded instruction that took you ten minutes to get right. When you need one again, it is buried in some
session you half remember.

Prompt search gives you reverse search across every prompt OpenCode has seen, right from the TUI. Find the old prompt,
press Enter, and it is inserted into your input box ready to edit.

## When to use it

- You reuse the same review, test, refactor, or release prompts across projects.
- You remember the wording of a prompt but not the session it came from.
- You want to build a personal library of prompts without a separate note-taking tool.
- You are onboarding to a project and want to reuse prompts a teammate or your past self wrote.

## What you get

- **Search across sessions.** Prompts from top-level sessions are indexed; subagent sessions are skipped.
- **Queued prompts included.** Messages still waiting in a session inbox are searchable too.
- **Insert, do not send.** Selecting a result places it at the cursor; you decide whether to edit or submit.
- **Survives restarts.** The index lives in local TUI storage, so history is available after a restart.
- **Deleted sessions still searchable.** Prompts cached before a session disappeared remain in the index.
- **Private.** The index is local; it is not sent to the model and does not modify your conversations.

## Quick start

Load it in the TUI configuration:

```jsonc
{
  "$schema": "https://opencode.ai/v2/cli.json",
  "plugins": [{
    "package": "@max10240/opencode-plugin-prompt-search",
    "options": { "keybind": "ctrl+shift+r" }
  }]
}
```

With Unicorn:

```jsonc
{
  "plugins": [{
    "package": "@max10240/opencode-plugin-unicorn",
    "options": {
      "features": { "promptSearch": true },
      "promptSearch": { "keybind": "ctrl+shift+r", "maxPrompts": 2000 }
    }
  }]
}
```

## Using it

Press `ctrl+shift+r` or search for **Search previous prompts** in the command palette.

1. Type words from the prompt you remember. Matches are listed newest first.
2. Use `↑` / `↓` to move through the results.
3. Press `Tab` to switch between all projects and the current project.
4. Press `Enter` to insert the original prompt at the cursor.
5. Edit it if needed, then send when you are ready.

The shortcut is chosen to avoid OpenCode's built-in bindings. You can change it to anything that feels natural.

## Configuration

| Option | Default | What it does |
| --- | --- | --- |
| `keybind` | `ctrl+shift+r` | Shortcut that opens prompt search |
| `maxPrompts` | `2000` | How many recent prompts to keep in the local index |

`maxPrompts` is a storage budget, not a search limit. When the index grows past the budget, the oldest prompts are
evicted first. Setting it to `0` clears the cache and stops retaining prompts. Raising it re-indexes sessions that are
still available on the server, but prompts from deleted and already-evicted sessions cannot be recovered.

## Good to know

- **Newest matches come first.** The query filters the index; it does not reorder results by relevance. Use `Tab` to limit the search to the current project.
- **Subagent prompts are not recorded.** Child sessions are skipped, and cached child-session prompts are removed on refresh.
- **Search is local and cheap.** The index is refreshed incrementally as sessions change; typing does not scan the
  whole server.
- **Historical means saved.** If a session was deleted before the plugin ever indexed it, OpenCode can no longer export
  it, so those prompts cannot be recovered.
- **Deleting a session does not immediately delete its cached prompts.** They remain until the storage budget evicts
  them.
- **A prompt is inserted, never sent.** You always get the final say before it reaches the agent.
- **The index is separate from the session database.** It is TUI storage, and uninstalling the plugin does not delete
  your conversations.
