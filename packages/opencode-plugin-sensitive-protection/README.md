# @max10240/opencode-plugin-sensitive-protection

**English** | [简体中文](README.zh-CN.md)

Register protected files and block or redact them before file reads or tool output reach model context. Works
standalone and does not depend on the encryption plugin.

## Capabilities

- `register_sensitive_file`: register a file by reading it into memory for matching; contents are never returned.
- `/protect-sensitive-file <path>`: register a file through the server command.
- `/protect-sensitive-file-ui` / keymap: prompt for a path in the TUI and register it.
- Exact-path `read` calls on a protected file throw `Tool.Error`.
- Sensitive spans in any tool output are replaced with `[REDACTED:PROTECTED]`.
- Final redaction is applied to model request context and HTTP request bodies.
- The registry persists entries by `kid`/path.
- When the encryption plugin is present, its decryption private key is registered automatically.

Inputs to `grep`, `shell`, `edit`, and `write` are not blocked; their output is redacted.

## Configuration

```jsonc
{
  "sensitiveProtection": {
    "enabled": true,
    "blockReads": true,
    "redactContext": true,
    "redactHttp": true,
    "maxContentBytes": 8388608
  }
}
```

- `enabled` defaults to `true`.
- `blockReads` defaults to `true`.
- `maxContentBytes` defaults to 8 MiB with a hard limit of 64 MiB.
- Matching supports whole content, individual lines, JSON escaping, Base64/Base64URL, and hex.

## Escape hatch

Place this in the current project:

```text
.opencode/sensitive-protection.json
```

```json
{ "enabled": false }
```

This disables protection only for the current project/location and does not affect the encryption plugin.

## Data

The registry is stored at:

```text
<XDG_DATA_HOME or ~/.local/share>/opencode/sensitive-protection/registry.json
```

Only paths and metadata are stored, never file contents.

## Limitations

Plugin hooks cannot guarantee detection across every encoding, compression format, split, MCP operation, or
subagent-internal operation. Strong isolation requires an OS sandbox or a separate user.
