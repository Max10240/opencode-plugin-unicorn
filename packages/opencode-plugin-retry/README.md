# @max10240/opencode-plugin-retry

**English** | [简体中文](README.zh-CN.md)

Interrupt a stuck OpenCode turn and send a configurable `Continue` prompt.

## What it does

Press `F5` or submit `/retry ` (the slash form takes no arguments; include the trailing space). There is no panel and
no command-palette entry.

- If the current session is idle, it immediately sends `Continue`.
- If the current session is running, it interrupts the turn, waits for the interrupt to settle, then sends
  `Continue`.
- If the interrupt does not settle within `timeoutMs` (default 1 second), it queues `Continue` for the next idle
  boundary and shows a top-right warning toast. `Continue` is not dropped.
- It never opens a panel.

The busy check is the current session execution status (`running` vs `idle`). A background shell or subagent that is
still running while the main turn is idle does not count as busy.

## Configuration

This is a TUI-side plugin. Put its options in `cli.json`.

Standalone:

```jsonc
{
  "$schema": "https://opencode.ai/v2/cli.json",
  "plugins": [
    {
      "package": "@max10240/opencode-plugin-retry",
      "options": {
        "keybind": "f5",
        "continueText": "Continue"
      }
    }
  ]
}
```

With Unicorn:

```jsonc
{
  "$schema": "https://opencode.ai/v2/cli.json",
  "plugins": [
    {
      "package": "@max10240/opencode-plugin-unicorn",
      "options": {
        "features": { "retry": true },
        "retry": {
          "keybind": "f5",
          "continueText": "Continue"
        }
      }
    }
  ]
}
```

| Option | Default | What it does |
| --- | --- | --- |
| `keybind` | `f5` | Shortcut for the retry command. Set to `false` to keep only `/retry`. |
| `continueText` | `Continue` | Message sent after the idle check or interrupt. |
| `timeoutMs` | `1000` | How long to wait for the interrupted turn to settle before queueing `Continue`. |

`features.retry: false` disables the plugin entirely in Unicorn.

## Why F5

`F5` is the standard refresh key on Windows (File Explorer and browsers). `F4` focuses the address bar, and `Alt+F4`
closes the window. OpenCode's default TUI bindings do not use `F5`.

The shortcut is only active in the normal session view. It does not fire inside modal dialogs such as permission or
question prompts. On macOS keyboards that require `Fn` for function keys, use `Fn+F5` or configure a different
`keybind`.

## Behavior details

- The interrupt is requested with `session.interrupt`; the plugin then waits with `experimental.session.wait` so
  a fast settlement sends `Continue` as a steer prompt into a fresh turn.
- If `interrupt` returns `interrupted: false`, the plugin re-checks the session. An idle session sends `Continue`
  directly; a turn that is still stopping waits for settlement before sending.
- If settlement exceeds `timeoutMs`, `Continue` is queued instead of steering it into the stopping turn. It runs at
  the next idle boundary without clearing messages already queued.
- Repeated presses while a retry is in progress are ignored.
- A composer draft is left untouched.
- Queued prompts are not cleared.
- If the source turn, permission prompt, or session disappears during the operation, the error is shown and no
  `Continue` is sent.
- If the feature is disabled or the configuration is invalid, no keybind or slash command is registered.
