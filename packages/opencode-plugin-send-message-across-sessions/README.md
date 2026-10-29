# @max10240/opencode-plugin-send-message-across-sessions

**English** | [简体中文](README.zh-CN.md)

Send user-style messages between OpenCode sessions in different working directories.

## Tools

- `list_online_sessions`: list sessions observed by the plugin, including session ID, title, working directory, and
  status.
- `send_message_across_sessions`: send a user-style message to another online OpenCode session. Use it only for
  cross-session communication, never between a main agent and its subagents. The message is injected with this stable protocol format:

  ```text
  来自<from_session_id>的消息: <message>
  ```

`delivery` controls when the message is delivered:

- `steer` (default): if the target is working, inject after its next tool call within the current turn; if idle,
  start a new turn immediately.
- `queue`: wait for the target's current turn to finish, then deliver in the next turn.

If `target_session_id` is omitted, the send tool returns the selectable session list. The model should ask the user
to choose and then call the tool again.

## Standalone configuration

```jsonc
{
  "plugins": [
    "@max10240/opencode-plugin-send-message-across-sessions",
  ],
}
```

The plugin is enabled by default. The session list is maintained from OpenCode server session events, so the target
must start after the plugin begins observing and both must run in the same OpenCode server.

## E2E

```bash
bun test
```

Tests use a local `opencode` binary, a local OpenAI-compatible proxy, and tmux. Every scenario has its own HOME, XDG
directories, configuration, and database. The plugin and its Unicorn dependencies are packed as local tarballs and
loaded without contacting the plugin registry. Coverage includes the standalone plugin and Unicorn integration, and
asserts that cross-directory sessions appear in the list and receive the user message. Set `OPENCODE_BIN` to choose
the OpenCode executable.
