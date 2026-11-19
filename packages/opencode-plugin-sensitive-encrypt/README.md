# @max10240/opencode-plugin-sensitive-encrypt

**English** | [简体中文](README.zh-CN.md)

**Handle secrets without putting them in the chat.**

Sometimes the agent needs to work with a secret: an API key, a private config, a credential file. Pasting it into the
conversation sends it to the model provider and leaves it in the transcript. Writing it to a plaintext file in the
project is not much better. And if you need to back up or share the secret, a random text file is the last thing you
want in Git.

This plugin gives you a simple encryption workflow built around two independent keys: encrypt with a public key,
decrypt with a private key, and never return plaintext to the conversation. You can encrypt from the TUI or let the
agent do it, and decryption always writes to a file.

## When to use it

- You need to store a secret in a repository or backup without committing plaintext.
- You want to hand an encrypted secret to an agent without revealing its contents.
- You need to decrypt a secret to a local file for a command, but not into the chat.
- You want a quick way to encrypt a block of text or a file from the TUI.
- You already use the sensitive-protection plugin and want the two to work together.

## What you get

- **Separate keys for separate jobs.** Encryption uses a public key; decryption uses a private key. They can belong to
  different people or purposes.
- **Text and file encryption.** Encrypt multiline text in memory or encrypt a file on disk.
- **Decrypt only to a file.** The decrypt tool never prints plaintext inline, so it does not leak into tool output.
- **Agent-friendly tools.** The agent can encrypt a file, decrypt one to a destination, or inspect the public key
  fingerprint.
- **A TUI panel.** Open it with `/encrypt-sensitive` or a keybind; no need to ask the agent.
- **Protection integration.** When sensitive-protection is enabled, the decryption key, encryption inputs, and decrypted
  outputs are registered automatically.

## Quick start

Standalone, load the package in both the server and TUI configuration:

```jsonc
// opencode.jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["@max10240/opencode-plugin-sensitive-encrypt"]
}
```

```jsonc
// cli.json
{
  "$schema": "https://opencode.ai/v2/cli.json",
  "plugins": ["@max10240/opencode-plugin-sensitive-encrypt"]
}
```

With Unicorn, it is enabled by default:

```jsonc
{
  "plugins": [{
    "package": "@max10240/opencode-plugin-unicorn",
    "options": { "features": { "sensitiveEncrypt": true } }
  }]
}
```

By default, enabled key pairs are created automatically in `<global config>/sensitive-encrypt/` when the plugin first
runs. Set `publicKeyFileForEncrypt` or `privateKeyFileForDecrypt` only when you already have keys. Paths in the
configuration are relative to the global OpenCode config directory unless absolute.

## Using it

### The TUI panel

Run `/encrypt-sensitive` or press the configured keybind.

- **Text mode** is the default. Type or paste multiline text; it is masked with `*` placeholders by default. Press
  `ctrl+r` to reveal or hide it. The text is encrypted in memory and never written as a plaintext file. You can
  optionally save the ciphertext to a path under `$TMPDIR`. After encryption the input is cleared and the result dialog
  shows where the ciphertext went.
- **File mode** (`ctrl+t`) encrypts a file under `$TMPDIR`. Enter the source path and an optional output path.
- **Key selector** lets you choose which public key to encrypt for. It defaults to the public key derived from your
  decryption key, so the plugin can decrypt the result.

Press `Enter` to encrypt and `Shift+Enter` to insert a newline in text mode. `Tab` moves between output and key, `F1`
opens help, and `Esc` closes. In the result dialog, `Enter` copies the ciphertext and closes, while `c` / `Ctrl+Y`
copies without closing; `p` copies the output path.

### The agent tools

| Tool | What it does |
| --- | --- |
| `encrypt_sensitive` | Encrypts one file with the configured public key and writes an `ocsec1` envelope |
| `decrypt_sensitive` | Decrypts an `ocsec1` file to the required `out` path; plaintext is never returned inline |
| `sensitive_key_info` | Shows the public keys and fingerprints; private keys are never returned |

To make files encrypted by the agent decryptable by this plugin, point `publicKeyFileForEncrypt` at
`sensitive-encrypt/decrypt-public.pem`, the public half of your decryption key. The TUI panel already does this by
default.

## Configuration

| Option | Default | What it does |
| --- | --- | --- |
| `enabled` | `true` | Turn the whole plugin on or off |
| `encrypt` | `true` | Enable or disable encryption |
| `decrypt` | `true` | Enable or disable decryption |
| `publicKeyForEncrypt` | generated | Inline public key (PEM or base64 DER) |
| `publicKeyFileForEncrypt` | generated | Path to the public key used for encryption |
| `privateKeyFileForDecrypt` | generated | Path to the private key used for decryption |
| `maxBytes` | `1048576` | Maximum file size for encryption or decryption; hard limit `64 MiB` |

Only one of `publicKeyForEncrypt` and `publicKeyFileForEncrypt` may be set. The legacy `publicKey` / `publicKeyFile`
names are still accepted.

## Good to know

- **Lose the private key and the data is gone.** There is no recovery path. Back up your key files.
- **Private keys stay on disk with strict permissions.** They must be regular files with mode `0600`; symlinks are
  rejected.
- **Decryption writes files, never chat messages.** The output is created with mode `0600`, never overwrites the input,
  and does not follow symlinks.
- **File paths stay under `$TMPDIR`.** Both the agent tools and the TUI File mode read and write only under the system
  temporary directory; secret input files must also be readable only by you (`0600`). Stage a file there, encrypt it,
  then move the ciphertext where you need it.
- **Encryption is not a vault.** It protects stored data and lets the agent handle ciphertext without seeing plaintext,
  but it does not stop the agent from reading a decrypted file with other tools. Pair it with sensitive-protection for
  that.
- **Encryption and decryption keys are independent.** The plugin does not check that they form a pair; use matching keys
  when you want to decrypt your own output.
- **The protection plugin is optional.** Without it, encryption and decryption still work, but automatic key/file
  registration is skipped.
