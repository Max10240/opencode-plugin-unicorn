# @max10240/opencode-plugin-non-blocking

**English** | [简体中文](README.zh-CN.md)

**Keep working while your agent runs long commands.**

A build takes two minutes. A test suite takes five. A subagent disappears to research a codebase. In every case, the
session is tied up in the foreground, and the agent cannot start anything else until the tool finishes.
OpenCode already has a manual escape hatch: press Ctrl+B and the work moves to the background. The problem is that you
have to notice, stop what you are doing, and press it every time.

This plugin presses it for you. After a configurable delay, long-running Bash and subagent calls move to the background
automatically, and the agent is free to take your next instruction.

## When to use it

- You run long builds, test suites, linters, package installs, or data processing jobs.
- You use subagents for research and want the parent session to stay responsive.
- You often switch tasks while the agent works and do not want to wait for the current tool call.
- You keep forgetting that Ctrl+B exists.

If your commands usually finish in a second or two, you probably do not need this plugin.

## What you get

- **No more waiting at the keyboard.** Blocking work moves to the background after ten seconds by default.
- **The agent gets to your next task sooner.** Queue the next request while the previous one runs in the background.
- **Every tool has its own deadline.** A command that finishes in time is never touched.
- **Manual control is respected.** If you press Ctrl+B yourself, the plugin forgets that tool and will not act on it
  again.
- **Subagents included.** Work inside subagent child sessions is monitored too.
- **Nothing new to learn.** Backgrounded work behaves exactly like work you moved with Ctrl+B; you still get notified
  when it completes.

## Quick start

The plugin is TUI-side. Load it in `cli.json`:

```jsonc
{
  "$schema": "https://opencode.ai/v2/cli.json",
  "plugins": [{
    "package": "@max10240/opencode-plugin-non-blocking",
    "options": { "thresholdMs": 10000 }
  }]
}
```

Using Unicorn? It is already enabled by default:

```jsonc
{
  "plugins": [{
    "package": "@max10240/opencode-plugin-unicorn",
    "options": {
      "features": { "nonBlocking": true },
      "nonBlocking": { "thresholdMs": 10000 }
    }
  }]
}
```

Disable it with `features.nonBlocking: false`.

## Configuration

| Option | Default | What it does |
| --- | --- | --- |
| `thresholdMs` | `10000` | How long a tool may run in the foreground before it is moved to the background |

Pick a threshold that matches your patience and your workloads. `5000` feels responsive; `30000` only intervenes for
genuinely long jobs.

## Good to know

- **Only Bash and subagents can be moved.** OpenCode's background support covers `shell` / `bash` and `subagent` /
  `task`. Other waiting tools, such as MCP tools, custom tools, or questions, have no background equivalent and are not
  handled.
- **Backgrounding is per session.** If several blocking tools are running in the same session, more than one may move
  together. This matches Ctrl+B behavior.
- **Nothing is canceled.** A backgrounded command keeps running. You can check on it later just like any other
  background job.
- **Already-background work is ignored.** Tools started with `background: true` are left alone.
- **Failures are quiet.** If OpenCode cannot move the work after a few retries, the TUI shows one warning instead of
  nagging you.
- **No new panel or badge.** The plugin stays out of the way; the existing background UI tells you what happened.
