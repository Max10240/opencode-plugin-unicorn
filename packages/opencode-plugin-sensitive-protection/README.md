# @max10240/opencode-plugin-sensitive-protection

**English** | [简体中文](README.zh-CN.md)

**Keep secrets out of the model conversation.**

Your repository contains a `.env`, a private key, a customer export, or a config file with a production token. The agent
has shell access and can read any of them. Even a harmless request like "check the database settings" can send those
contents to the model provider and leave them in the transcript.

Sensitive protection lets you mark files as private. The plugin blocks direct reads and replaces matching content with
`[REDACTED:PROTECTED]` before it reaches the model, whether it came from a read, a shell command, or another tool.

## When to use it

- Your project contains credentials, tokens, private keys, or customer data.
- You use OpenCode on a shared machine or with a hosted model provider.
- You want a safety net for accidental `cat .env` moments.
- You want the agent to work in a repository without reading its secrets.
- You use the sensitive-encrypt plugin and want its keys protected automatically.

## What you get

- **Block direct reads.** A `read` call on a protected file fails instead of returning its contents.
- **Redact everything else.** Secrets that appear in tool output are replaced before the model sees them.
- **Cover the final request.** Redaction is applied to the full model request, not only to the visible tool result.
- **Register from anywhere.** Ask the agent, use a server command, or open a TUI prompt. The agent never receives the
  file contents during registration.
- **Remember across sessions.** The registry is persisted by file path, so protection survives restarts.
- **Works with encryption.** When the encryption plugin is present, its decryption key and the files it handles are
  protected automatically.

## Quick start

Standalone, load the package in the server configuration. Add the TUI entry too if you want the interactive
registration command:

```jsonc
// opencode.jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["@max10240/opencode-plugin-sensitive-protection"]
}
```

```jsonc
// cli.json
{
  "$schema": "https://opencode.ai/v2/cli.json",
  "plugins": ["@max10240/opencode-plugin-sensitive-protection"]
}
```

With Unicorn, it is enabled by default:

```jsonc
{
  "plugins": [{
    "package": "@max10240/opencode-plugin-unicorn",
    "options": {
      "features": { "sensitiveProtection": true },
      "sensitiveProtection": {
        "blockReads": true,
        "redactContext": true,
        "redactHttp": true
      }
    }
  }]
}
```

## Using it

Register a file in whichever way fits your workflow:

- Ask the agent to use `register_sensitive_file` with the path.
- Run `/protect-sensitive-file <path>` on the server.
- Run `/protect-sensitive-file-ui` or the configured keymap in the TUI and enter a path.

After that, direct `read` calls on the file are blocked. If its contents show up in any tool output, the matching spans
become `[REDACTED:PROTECTED]`.

The plugin redacts output from `grep`, shell commands, `edit`, and `write`; it does not block their inputs. Reading the
file through a shell command is therefore allowed, but the secret is removed before the model sees it.

## Configuration

| Option | Default | What it does |
| --- | --- | --- |
| `enabled` | `true` | Turn protection on or off |
| `blockReads` | `true` | Block exact-path `read` calls on protected files |
| `redactContext` | `true` | Redact secrets from model request context |
| `redactHttp` | `true` | Redact secrets from requests sent to the model provider |
| `maxContentBytes` | `8388608` | Maximum file size loaded for matching; hard limit `64 MiB` |

Matching covers whole content, individual lines, JSON-escaped text, Base64/Base64URL, and hex.

## Project escape hatch

If a particular project needs protection off, create:

```text
.opencode/sensitive-protection.json
```

```json
{ "enabled": false }
```

This affects only the current project and does not disable the encryption plugin.

## Good to know

- **This is a strong safety net, not a sandbox.** A determined agent, unusual encoding, compressed data, split output,
  or an MCP/subagent operation may evade matching. For strong isolation, use an OS sandbox or a separate user.
- **Only paths and metadata are stored.** The registry lives under
  `<XDG_DATA_HOME or ~/.local/share>/opencode/sensitive-protection/registry.json`; file contents are not kept there.
- **Registration is per file path.** Moving or renaming a protected file may require registering it again.
- **The agent can still see that a file exists.** Protection hides content, not file names or metadata.
