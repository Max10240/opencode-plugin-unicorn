# @max10240/opencode-plugin-send-message-across-sessions

**English** | [简体中文](README.zh-CN.md)

**Let your OpenCode sessions talk to each other.**

Real work rarely fits in one directory. You might run one session for the frontend and another for the backend, or keep
separate worktrees for separate features. Each session has its own context, and you become the messenger: copy a finding
from one, paste it into the other, repeat.

This plugin gives the agent two tools for talking to other sessions. It can list who is online and send a message with
the right timing, so parallel work stays coordinated without you relaying every detail.

## When to use it

- Frontend and backend sessions need to agree on an API contract.
- Two worktrees are changing related code and should share findings.
- A research session discovers something that another implementation session needs.
- You want to hand off a task to a different project without copying a long summary.
- You run several agents in parallel and want them to ask each other questions.

## What you get

- **Session discovery.** The agent can see other online sessions, their titles, working directories, and status.
- **User-style messages.** The receiving session gets a normal message, marked with the sender, and responds in its own
  context.
- **Timing you control.** Choose whether a busy session should be interrupted after its next tool call or waited for.
- **No copy-paste relays.** Findings, constraints, and handoffs move directly between sessions.
- **Minimal setup.** Load the plugin once; there is nothing to configure.

## Quick start

Load it in the server configuration:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["@max10240/opencode-plugin-send-message-across-sessions"]
}
```

With Unicorn, it is enabled by default:

```jsonc
{
  "plugins": [{
    "package": "@max10240/opencode-plugin-unicorn",
    "options": { "features": { "sendMessageAcrossSessions": true } }
  }]
}
```

## Using it

Just ask the agent in plain language:

> Ask the backend session what shape the `/users` response will have, then adapt our client types.

The agent uses `list_online_sessions` to find the target and `send_message_across_sessions` to deliver the message. If
it does not know which session you mean, it returns the list and asks you to choose.

`list_online_sessions` returns up to 20 sessions per page. Pass `offset` to page through larger lists; the result
metadata includes `total` and the next offset. The list is served from an event-maintained directory, so the
tool never queries the session database while a turn is running.

### Delivery modes

| Mode | Behavior | Good for |
| --- | --- | --- |
| `steer` (default) | Delivers immediately | Time-sensitive coordination |
| `queue` | Waits until the target is fully idle; this can take a long time and the message may be stale | Non-urgent messages |

Every send includes `need_reply`. Set it to `true` when the message needs an answer; the receiver then sees a reply
request at the end of the message.

## Good to know

- **Both sessions must share one OpenCode server.** The plugin only sees sessions on the server where it runs.
- **Online means known to the server.** Closing a TUI or client does not delete its session, so it may still appear.
  Deleting the session removes it. A deletion that happens while the plugin is not running can leave a stale entry
  until it is cleaned up or the session is seen again.
- **The list is server-authoritative.** It reads `session.list`, so sessions that existed before the plugin started are
  included. Archived sessions are omitted. Running status comes from the session's busy/idle timestamps.
- **A short-lived storage cache is pruned.** Stale `online-sessions/` records are removed when the authoritative list is
  read, so deleted sessions do not remain visible indefinitely.
- **This is for peer sessions, not parent and subagent.** Use OpenCode's built-in subagent tool for parent-child work.
- **The receiving session sees a normal user message.** There is no hidden side channel; the message becomes part of
  that session's conversation.
- **No configuration is required.** Load it and ask.
