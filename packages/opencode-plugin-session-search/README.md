# @max10240/opencode-plugin-session-search

**English** | [简体中文](README.zh-CN.md)

**Find anything you or the agent said, then jump straight to it.**

A long OpenCode session can run for hours. The decision you need, the command that worked, or the error you are
debugging slides thousands of lines up the scrollback. When OpenCode compacts the conversation, earlier messages
disappear from view, even though they still exist in history.

Session search gives the current conversation a proper search box. Type what you remember, preview the matches, and
press Enter to jump to the message. You can also copy the exact text without moving.

## When to use it

- You are deep in a long debugging, planning, or implementation session.
- Compaction has hidden earlier messages that you still need.
- You want to find a command, file path, decision, or error message from an hour ago.
- You need to copy a previous instruction or answer without scrolling.
- You want to search agent messages, not only your own prompts.

## What you get

- **Search the full saved history.** Not just the messages currently loaded or the model context.
- **Works before and after compaction.** Real user and agent messages remain searchable; summaries are not treated as
  original dialogue.
- **Jump to the source.** Enter scrolls the conversation to the matching message or text part.
- **Copy without jumping.** `Ctrl+Y` copies the selected text and leaves your place alone.
- **Choose whose words to search.** User messages are shown by default; `Tab` adds agent messages.
- **Never changes the conversation.** Searching, jumping, and copying never insert, submit, resend, or revert anything.

## Quick start

Load it in the TUI configuration:

```jsonc
{
  "$schema": "https://opencode.ai/v2/cli.json",
  "plugins": [{
    "package": "@max10240/opencode-plugin-session-search",
    "options": { "keybind": "ctrl+shift+f" }
  }]
}
```

With Unicorn:

```jsonc
{
  "plugins": [{
    "package": "@max10240/opencode-plugin-unicorn",
    "options": {
      "features": { "sessionSearch": true },
      "sessionSearch": { "keybind": "ctrl+shift+f" }
    }
  }]
}
```

## Using it

Press `ctrl+shift+f`, or choose **Search current session** from the command palette.

| Key | Action |
| --- | --- |
| Type | Filter matches; words are combined with AND, case-insensitively |
| `↑` / `↓` | Select a match |
| `Enter` | Jump to the matching message or text part |
| `Ctrl+Y` | Copy the selected text without jumping |
| `Tab` | Switch between user-only and user + agent messages |
| `Esc` | Close the dialog, or cancel navigation while a jump is loading |

Up to 100 matches are shown at once. Keep typing to narrow them down. A copy confirmation appears in the dialog and
fades after a few seconds; changing the query or message scope clears it immediately.

## Configuration

| Option | Default | What it does |
| --- | --- | --- |
| `keybind` | `ctrl+shift+f` | Shortcut that opens current-session search |

`features.sessionSearch: false` disables the plugin through Unicorn.

## Good to know

- **Jumping targets the start of a message or text part.** Long Markdown blocks may not scroll to the exact matching
  character line.
- **Distant jumps can take a moment.** Very old messages may need to be loaded first; very long sessions are not
  guaranteed to feel instant.
- **Content deleted on the server cannot be recovered.** Search only sees what OpenCode still stores.
- **Queued prompts are marked, not jumped to.** Undelivered messages can be copied but not navigated to, and selecting
  a result never sends them.
- **Matches after a revert boundary are not navigable.** Search respects the revert instead of canceling it.
- **The index is memory-only.** It is rebuilt as needed and is not written to disk.
- **Verified with OpenCode `v2.0.21` and `v2.1.0`.** Other versions have not been validated.
