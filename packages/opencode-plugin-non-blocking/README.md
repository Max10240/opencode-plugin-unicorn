# @max10240/opencode-plugin-non-blocking

**English** | [简体中文](README.zh-CN.md)

Move long-running blocking OpenCode tools to the background without waiting for the user to press Ctrl+B. The
monitoring and timing logic runs entirely in the TUI; the server entry is a no-op.

## Behavior

- Watches foreground `shell` / `bash` and `subagent` / `task` tool calls in every session the TUI observes, including
  subagent child sessions.
- After a tool has been running for 10 seconds by default, calls the same `session.background` API as Ctrl+B for that
  session.
- The API is session-scoped. If several blocking tools are active in the same session, more than one may be moved to the
  background together; this is intentional.
- Every tool has its own deadline. A tool that finishes before its deadline is ignored.
- Manually pressing Ctrl+B removes the affected tools from monitoring. They are never handled again by the plugin.
- Tools started with `background: true` are already in the background and are ignored.
- Other waiting tools such as MCP tools, custom tools, or questions are not backgroundable through the OpenCode API.
  They are not monitored or actioned by this plugin.
- No panel or persistent UI is added. If backgrounding still fails after retries, the TUI shows one warning toast for that session.

## Configuration

Standalone:

```jsonc
{
  "plugins": [
    {
      "package": "@max10240/opencode-plugin-non-blocking",
      "options": { "thresholdMs": 10000 }
    }
  ]
}
```

`thresholdMs` is the minimum foreground runtime before backgrounding. It defaults to `10000`.

Unicorn enables the plugin by default. Disable it independently with `features.nonBlocking: false`, or configure the
threshold with `options.nonBlocking.thresholdMs`.

## Performance

- Event-driven state: no polling of session history.
- One timer per running blocking tool.
- Timers and listeners are removed when a tool settles, a session is deleted, or the plugin unloads.
- The plugin does not render any UI.
- Background calls are retried with backoff instead of tight polling.

## Compatibility

The plugin uses the existing `session.background` API and requires no OpenCode source changes. Because that API is
session-scoped, it cannot select a single job when several blocking tools run together; the plugin therefore treats
the session as the backgrounding unit.
