# @max10240/opencode-plugin-recomended-opencode-config

**English** | [简体中文](README.zh-CN.md)

**A safer, more consistent OpenCode setup from day one.**

A fresh OpenCode installation is a blank slate. You can spend weeks tuning global rules, adding review and planning
commands, and discovering which defaults you want. You can also inherit a baseline that already encodes those habits.

This plugin merges a curated set of global rules and commands into your existing configuration. It adds what is
missing, does not overwrite your rules or same-name commands, and turns on OpenAI's `store:false` setting when OpenAI
is already configured.

It is opinionated by design: the recommendations come from the same rules used to maintain this repository, not from a
generic template.

## When to use it

- You are setting up OpenCode and want sensible guardrails without writing them yourself.
- You want the agent to follow consistent habits around communication, sensitive data, and configuration changes.
- You want ready-made commands for reviewing changes, committing, investigating, planning, and keeping work moving.
- You use OpenAI and prefer not to have requests stored by default.
- You maintain several machines and want the same baseline everywhere.

If you already have a carefully tuned global configuration and do not want opinions added, skip this plugin.

## What you get

- **Recommended rules.** Adds a section to your global `AGENTS.md` covering communication style, sensitive data,
  safe configuration edits, and local testing habits.
- **Recommended commands.** Adds missing commands for review, commit, inspection, investigation, planning, and
  sustained work.
- **OpenAI privacy default.** Sets `providers.openai.settings.store:false` when OpenAI is configured, without changing
  your model or variant choices.
- **Non-destructive merging.** Existing rules with the same title are kept, same-name commands are not overwritten,
  and comments and unrelated settings are preserved.
- **Safe to run again.** Running it repeatedly does not keep appending duplicates or rewrite files unnecessarily.
- **No credentials.** It never creates an OpenAI key and never includes secrets in rules or commands.

## Quick start

Load it in the server configuration and enable it explicitly:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [{
    "package": "@max10240/opencode-plugin-recomended-opencode-config",
    "options": { "enabled": true }
  }]
}
```

With Unicorn:

```jsonc
{
  "plugins": [{
    "package": "@max10240/opencode-plugin-unicorn",
    "options": {
      "features": { "recommendedOpencodeConfig": true },
      "recommendedOpencodeConfig": { "enabled": true }
    }
  }]
}
```

This plugin is not enabled by default. If `enabled` is not set, it turns on only when the server environment's
`IS_MAX_SELF` variable is non-empty and is not `0` or `false`. Set `enabled: false` to force it off.

## Check what was applied

Run `/recommended` or choose **Recommended config status** from the command palette. The read-only panel shows:

- which config files were found;
- how many recommended rules and commands are present;
- the exact rules and commands that are still missing;
- whether automatic updates are enabled.

The panel does not change files. Press `r` to refresh and `?` for help.

## What it changes

| Area | Behavior |
| --- | --- |
| Global `AGENTS.md` | Adds the recommended rules under a dedicated section, creating or reusing it at the top heading level |
| Global commands | Adds missing slash commands from the recommended set; same-name user commands win |
| OpenAI settings | Sets `providers.openai.settings.store:false` when OpenAI is configured; explicit model and variant settings stay untouched |
| `opencode.jsonc` | Preserves JSONC comments and unrelated fields; creates the file only if commands are missing and no config exists |

The global directory follows `OPENCODE_CONFIG_DIR`, then `$XDG_CONFIG_HOME/opencode`, then `~/.config/opencode`.

## Good to know

- **Disabling does not undo.** Turning the plugin off stops future merges but does not remove rules or settings that
  were already written.
- **Your content wins.** Equal rule titles are skipped, and same-name commands are not overwritten.
- **Failures are non-fatal.** If a merge cannot be completed safely, the plugin warns and lets other plugins start.
- **The recommendations are curated, not universal.** Review them before enabling if you have strong opinions about
  how an agent should behave.
- **No model configuration changes.** The plugin does not change context limits, sharing, or your chosen models.
