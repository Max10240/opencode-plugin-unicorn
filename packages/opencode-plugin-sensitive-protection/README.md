# @max10240/opencode-plugin-sensitive-protection

**English** | [简体中文](README.zh-CN.md)

**Keep secrets out of the model conversation.**

Your machine and project contain credentials: AI CLI logins, cloud keys, SSH keys, package registry tokens, and
`.env` files. An agent with shell access can read them, and even a harmless "check the config" request can send the
contents to the model provider.

Sensitive protection knows the common credential files, extracts only the sensitive fields, blocks direct access when
appropriate, and replaces those values with `[REDACTED:PROTECTED]` before they reach the model. It also shows a
top-right TUI toast, a clickable details chip, and a live history dialog whenever a rule fires, so protection never
fails silently.

## What is protected by default

The plugin reads only the fields listed below. It does not use the whole file or every line as a redaction pattern.

| Group | Default files | Fields |
| --- | --- | --- |
| AI agents | `~/.local/share/opencode/auth.json`, `~/.codex/auth.json`, `~/.claude/.credentials.json`, `~/.gemini/oauth_creds.json` | `key`, `token`, `access`, `refresh`, `OPENAI_API_KEY`, `access_token`, `refresh_token`, `id_token`, `accessToken`, `refreshToken`, `personal_access_token` |
| Cloud | `~/.aws/credentials`, `~/.config/gcloud/application_default_credentials.json`, `~/.kube/config` | AWS key/secret/session token; GCP `client_secret`, `refresh_token`, `private_key`, `access_token`; kubeconfig `token`, `password`, `client-key-data` |
| Source control | `~/.config/gh/hosts.yml`, `~/.git-credentials`, `~/.ssh/id_rsa`, `id_ed25519`, `id_ecdsa`, `id_dsa` | GitHub `oauth_token`; Git URL password; SSH private key block |
| Package registries | `~/.npmrc`, `~/.pypirc`, `~/.cargo/credentials.toml` or `~/.cargo/credentials` | npm `_authToken`, `_auth`, `_password`; PyPI `password`; Cargo registry `token` |
| Infrastructure | `~/.terraform.d/credentials.tfrc.json`, `~/.docker/config.json` | Terraform host `token`; Docker `auths.*.auth`, `identitytoken`, `registrytoken` |
| Plain tokens | `~/.netrc`, `~/.vault-token` | netrc `password`; Vault token |

`.env` files are **not** protected by default. They are project-specific and often mix ordinary configuration with
secrets; add them explicitly with `customFiles` when you want protection. Copilot/Cursor fallback files, Azure token caches,
Terraform `.terraformrc` HCL, browser databases, and shell history are also outside this first set.

When the sensitive-encrypt plugin is enabled, its decryption key, encryption inputs, and decrypted outputs are
registered automatically.

## Read and write behavior

- **Built-in and custom structured files are readable but redacted.** An agent can inspect the structure of an npmrc,
  auth JSON, kubeconfig, or `.env`, but secret values appear as `[REDACTED:PROTECTED]`. This keeps normal configuration
  work possible.
- **Built-in and custom whole-file writes are blocked.** Agents cannot overwrite a protected file with a new version
  and accidentally destroy the secrets inside it.
- **Private keys and Vault tokens are fully blocked.** Reading and modifying SSH private keys or the Vault token is
  rejected.
- **Shell output is redacted.** `cat`, `grep`, and other tools still run, but extracted secret values are removed from
  their output before the model sees it.

## TUI notifications

A hit produces a toast in the top-right corner of the TUI:

```text
Sensitive protection
Blocked read to id_ed25519

Sensitive protection
Redacted 2 sensitive values from shell output

Sensitive protection warning
Could not extract sensitive values from .npmrc; reads are blocked
```

A tool call with many matches produces one toast with a count, not one per value. Toasts never contain the secret value
itself.

The count is the number of occurrences in that outbound request, not a cumulative total. The model context is rebuilt
for every model request, so the same still-present values can be redacted again on every turn. Protection aggregates
that repeated condition and does not re-toast it on every request. A new affected file or key, or a higher count,
still alerts.

The host renders the toast and the plugin API does not expose a click action for it. To keep details one action away:

- A clickable `access blocked · details` or `N values redacted · details` chip appears in the composer footer for 30
  seconds after an alert.
- `ctrl+shift+h` opens the same history dialog. Set `historyKeybind` to change it or `false` to disable the binding.
- `/protection-history` and the command palette work even when notifications are off. The command opens all sessions; the
  footer chip opens the triggering session.

When a trigger comes from another session, the toast also offers `Open` to jump to that session. The footer chip still
opens the history dialog for the full context.

Notifications require the TUI entry. With Unicorn both entries are loaded automatically. Standalone, load the package
in both `opencode.jsonc` and `cli.json`.

## Protection history

The history dialog shows recent triggers with the information needed to decide what happened:

- whether access was blocked or values were redacted, and at which stage (model context, provider request, tool output,
  or file read);
- the protected file and the extracted key that matched, such as `_authToken` in `~/.npmrc`;
- the triggering session title, short session ID, and project folder;
- when the condition was first and last seen, and how many times it occurred.

The list updates live while the dialog is open. Press `t` to open the filter menu, `0` to reset it, `s` to switch
between this session and all sessions, `c` to copy the selected report, `enter` to open the triggering session, and
`x` twice to clear the history. A deleted session is shown as unavailable instead of failing the dialog.

Press `f` to switch to Protected files. That view lists the files currently in the protection registry with their
source, read/write policy, extracted key labels, and most recent hit. Press `enter` to return to History filtered to
the selected file, `backspace` to clear that file filter, and `c` to copy the path and key labels. Values are never
shown. The file list refreshes when the registry changes and can be reloaded with `r`.

History is metadata only. It never contains a secret value, is kept in memory on the server, and disappears when the
server exits. The client keeps at most 1,000 events and renders at most 100 rows at a time. Repeated conditions are
merged, so the list stays useful instead of growing on every request.

## Quick start

Standalone:

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
        "builtins": true,
        "notifications": true
      }
    }
  }]
}
```

## Custom files

Use `customFiles` to protect a file that is not built in. Prefer the declarative form when the format is one of JSON,
YAML, INI, or TOML:

```jsonc
{
  "sensitiveProtection": {
    "customFiles": [
      {
        "path": "~/work/secrets.json",
        "format": "json",
        "fields": ["apiKey", "token"]
      },
      {
        "path": "~/.npmrc",
        "format": "ini",
        "fields": ["_authToken", "_auth", "_password"]
      }
    ]
  }
}
```

Each custom file also accepts `read` (`redact` or `block`) and `write` (`block` or `allow`). For unusual formats, an
extractor can return the values to protect. It runs locally in the server process:

```jsonc
{
  "sensitiveProtection": {
    "allowCustomExtractors": true,
    "customFiles": [{
      "path": "~/.npmrc",
      "extractor": "const data = context.parseIni(); return Object.entries(data).filter(([key]) => key.endsWith('_authToken') || key.endsWith('_auth') || key.endsWith('_password')).map(([, value]) => value)"
    }]
  }
}
```

The `context` object provides:

| Field | Meaning |
| --- | --- |
| `file` | Absolute path of the configured file |
| `home` | Current home directory |
| `readFile(path?)` | Read UTF-8 text; defaults to `file`, with the size limit applied |
| `parseJson(text?)` | Parse JSON, or the file when no text is passed |
| `parseYaml(text?)` | Parse YAML |
| `parseIni(text?)` | Parse INI/key-value files |
| `parseToml(text?)` | Parse TOML |

The extractor must return `string[]` containing only the secret values. It is arbitrary local code and is not a
sandbox. Enable it only in trusted user configuration; do not commit extractor code to an untrusted repository.

## Configuration

| Option | Default | What it does |
| --- | --- | --- |
| `enabled` | `true` | Turn protection on or off |
| `builtins` | `true` | Load the built-in credential file list |
| `disabledBuiltinGroups` | `[]` | Disable groups: `aiAgents`, `cloud`, `sourceControl`, `packageRegistries`, `infrastructure`, `plaintextTokens`, `sshKeys` |
| `blockReads` | `true` | Block reads of entries whose read policy is `block` |
| `redactContext` | `true` | Redact secrets from model request context |
| `redactHttp` | `true` | Redact secrets from requests sent to the model provider |
| `maxContentBytes` | `8388608` | Maximum file size read for extraction; hard limit `64 MiB` |
| `customFiles` | `[]` | Extra files and their extractors |
| `allowCustomExtractors` | `false` | Allow JavaScript `extractor` strings in `customFiles` |
| `notifications` | `true` | Show TUI toasts and the footer details chip for hits and parser errors |
| `historyLimit` | `200` | Maximum stored history conditions, `0`–`1000`; `0` keeps only live events for the current TUI |
| `historyKeybind` | `"ctrl+shift+h"` | Shortcut for protection history; `false` disables the binding |

Built-in files are refreshed every two seconds when their `mtime`, size, or inode changes. The plugin never refreshes
tokens itself; it only re-extracts values after the owning CLI updates a file.

## Manual registration

You can still register any file explicitly:

- Ask the agent to use `register_sensitive_file`.
- Run `/protect-sensitive-file <path>` on the server.
- Run `/protect-sensitive-file-ui` or the configured keymap in the TUI.

Manually registered files use whole-file matching and are persisted in
`<XDG_DATA_HOME or ~/.local/share>/opencode/sensitive-protection/registry.json`. Built-in and custom file definitions
are not persisted there.

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

- **This is a guardrail, not a sandbox.** A determined agent, unusual encoding, compressed data, split output, or an
  MCP/subagent operation may evade matching. For strong isolation, use an OS sandbox or a separate user.
- **Built-in/custom entries keep only extracted values in memory.** Manual registrations use whole-file patterns; the
  registry on disk stores paths and metadata, not file contents.
- **Moving or renaming a file can require re-registering it.**
- **Some AI agents keep credentials in the OS keychain.** Only their plaintext fallback files can be protected.
- **OpenCode V2 stores credentials in SQLite.** `opencode.db` is a binary database and is not read by this version; only the legacy
  `auth.json` and the text files in the built-in list are covered.
- **The agent can still see that a file exists.** Protection hides content, not file names or metadata.
- **Protection history stays local and metadata-only.** It records file paths, key names, session IDs, titles, and
  folders, never secret values, and it is not written to disk. Clear it from the dialog with `x`, `x`.
