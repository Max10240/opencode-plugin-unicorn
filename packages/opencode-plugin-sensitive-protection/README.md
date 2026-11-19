# @max10240/opencode-plugin-sensitive-protection

**English** | [简体中文](README.zh-CN.md)

**Keep secrets out of the model conversation.**

Sensitive protection parses known credential files locally, extracts only secret values, and replaces those values with
`[REDACTED:PROTECTED]` before they reach the model. It also blocks direct reads when a protected file cannot be parsed.

## Configuration

All configuration lives in the OpenCode plugin options. There are no plugin-specific config files.

Standalone:

```jsonc
{
  "plugins": [{
    "package": "@max10240/opencode-plugin-sensitive-protection",
    "options": {
      "files": [
        "!~/.npmrc",
        {
          "path": "~/.config/newcli/credentials.json",
          "format": "json",
          "keys": ["access_token", "servers[].password"]
        }
      ]
    }
  }]
}
```

With Unicorn:

```jsonc
{
  "plugins": [{
    "package": "@max10240/opencode-plugin-unicorn",
    "options": {
      "features": { "sensitiveProtection": true },
      "sensitiveProtection": {
        "files": [
          "!~/.npmrc",
          {
            "path": "~/.config/newcli/credentials.json",
            "format": "json",
            "keys": ["access_token", "servers[].password"]
          }
        ]
      }
    }
  }]
}
```

### `files`

The final protection list is:

```text
default entries + config files + manual entries - exclusions
```

- Default entries are added automatically, including AI CLI credentials, cloud credentials, Git/SSH, package registry
  tokens, Terraform/Docker, netrc, and Vault.
- A string starting with `!` removes a path from any source: `"!~/.npmrc"`.
- An object adds or overrides a file: `{ "path": "...", "format": "json", "keys": ["token"] }`.
- Same path priority: config > manual > default.
- No `customFiles`, `builtins`, per-file read/write, or custom extractor options.

## Supported formats

| Format | Parser | Use |
| --- | --- | --- |
| `json` | native | JSON credentials and config |
| `yaml` | `yaml` | kubeconfig, GitHub hosts, YAML config |
| `ini` | `ini` | npmrc, AWS credentials, `.env`, INI |
| `toml` | `smol-toml` | Cargo and TOML config |
| `private-key` | built-in | PEM / OpenSSH private keys |
| `line` | built-in | one-line secret files |
| `netrc` | built-in | netrc credentials |
| `git-credentials` | built-in | Git credential files |

All structured formats are parsed into a JavaScript object and matched with one selector engine. No per-format matcher
is installed.

## Key selectors

Use `.` for nesting and `[]` for every array element.

```text
auth.token
servers[].password
```

Other supported forms:

```text
servers[*].password     same as servers[].password
servers[0].password     one array index
tokens[]                every string element of an array
credentials.*.token     any child key
*_authToken             key-name glob (used by default entries)
```

Every selector must match at least one non-empty string. If any selector is missing, the whole registration is rejected
and the error lists every missing selector plus the available key paths.

Use `inspect` with the registration tool to list available key paths without reading values.

## Tool

`register_sensitive_file` registers a file locally. It never returns file contents.

- Structured files: pass `format` and a non-empty `keys` array.
- Private keys: pass `format: "private-key"`.
- Single-line secrets: omit `format` and `keys`.
- Other multi-line files are rejected. Split them into one secret per file, or use a structured format with keys.
- `inspect: true` returns key paths only.

`request_sensitive_unprotect` creates a pending unprotect request. It never removes protection directly. The user must
approve the request in the TUI.

## Protection policy

The same policy applies to every protected file:

| Operation | Behavior |
| --- | --- |
| `read` | allowed, secret values redacted |
| `write` | allowed |
| `edit` | allowed |
| writing `[REDACTED:PROTECTED]` | blocked |
| parser failure | `read` blocked; write/edit still allowed |
| shell output | redacted |
| model context / provider request | redacted |

## Default files

| Group | Files |
| --- | --- |
| AI agents | OpenCode, Codex, Claude, Gemini credential files |
| Cloud | AWS, Google ADC, kubeconfig |
| Source control | GitHub CLI hosts, Git credentials, SSH private keys |
| Package registries | npm, PyPI, Cargo |
| Infrastructure | Terraform, Docker |
| Plain tokens | netrc, Vault token |

`.env` files are not protected by default; add them with `format: "ini"` and their keys.

## Unprotect

Users can unprotect any file directly from the Protected files dialog:

- manual entry: removed from the registry;
- default/config entry: a `!path` disabled override is stored in runtime state;
- the Disabled filter restores removed files.

Agent-initiated unprotect requests show a toast and a persistent footer badge until the user approves or rejects them.
The badge is only shown while at least one request is pending.

Approving is a two-step action: `a` opens a review panel with the file, source, session, project, and reason; then
`y` or `Enter` confirms, and `n` or `Esc` cancels. `r` rejects the request. Approval stays in effect for future turns
until the file is registered again. In the protection history, `?` shows help, `c` / `Ctrl+Y` copies, and `Ctrl+T`
opens the filter.

## Synchronization

Protection is shared by all projects and sessions inside one OpenCode server. The Protected files dialog shows the whole server and labels each file with its project. Pending unprotect requests are also shared across sessions in that server. No cross-server
snapshot or heartbeat is used.

## Runtime state

Manual entries, disabled overrides, and pending requests are stored in:

```text
$XDG_DATA_HOME/opencode/sensitive-protection/registry.json
```

or `~/.local/share/opencode/sensitive-protection/registry.json`. The file stores paths and metadata only, never secret
values.

## Good to know

- This is a guardrail, not a sandbox. Encoded, compressed, split, or MCP/subagent output may evade matching.
- Protected file names and metadata remain visible; content is hidden.
- Files must exist, be regular files, and be below `maxContentBytes`.
- Moving or renaming a file can require re-registration.
- Manual protection is server-wide; default/config entries follow their configuration scope.
- OpenCode V2 credentials in SQLite and OS keychains are not covered.
