# @max10240/opencode-plugin-sensitive-encrypt

**English** | [简体中文](README.zh-CN.md)

Encrypt sensitive text or files with an independent public key and decrypt them with a separate private key.
Plaintext and private keys never enter model context.

## Tools

- `encrypt_sensitive`: encrypt a single file with `publicKeyForEncrypt` / `publicKeyFileForEncrypt`.
- `decrypt_sensitive`: decrypt an `ocsec1` envelope with `privateKeyFileForDecrypt`. **It must write to `out`** and
  never returns plaintext inline.
- `sensitive_key_info`: show the encryption/decryption public keys and `kid`; private keys are never returned.

## Configuration

```jsonc
{
  "sensitiveEncrypt": {
    "encrypt": true,
    "decrypt": true,
    "publicKeyForEncrypt": "-----BEGIN PUBLIC KEY-----...",
    "publicKeyFileForEncrypt": "sensitive-encrypt/encrypt-public.pem",
    "privateKeyFileForDecrypt": "sensitive-encrypt/decrypt-private.pem",
    "maxBytes": 1048576
  }
}
```

- `encrypt` / `decrypt` default to `true`; set either to `false` or `null` to disable it.
- `maxBytes` defaults to 1 MiB with a hard limit of 64 MiB.
- Encryption and decryption keys are independent; they are not derived from each other or checked as a pair.
- The default directory is `<global config>/sensitive-encrypt/`, with separate `encrypt-*` and `decrypt-*` key pairs.
- Legacy `publicKey` / `publicKeyFile` remain silently compatible and are equivalent to the new encrypt names.

## Key security

- Private key files must be regular files with mode `0600`; symlinks are rejected.
- The private key is re-read for every decryption and is not cached long-term.
- Decrypted output is written with mode `0600`, atomically replaced, and never overwrites the input or follows
  symlinks.
- Losing the private key makes existing ciphertext unrecoverable.

## TUI

Run `/encrypt-sensitive` or a configured keybind to open the encryption panel. The panel starts in **Text** mode and
switches to **File** mode with `ctrl+t`:

- **Text**: type arbitrary multiline text. It is encrypted in memory through the plugin RPC, never written as a
  plaintext file, and does not use the `encrypt_sensitive` tool. An optional ciphertext output path is available.
- **File**: type the source file path manually and optionally an output path.
- **Key**: defaults to the public key derived from the decryption private key, so `decrypt_sensitive` can decrypt
  new output. `Tab` to the key selector and use Left/Right to switch to the configured encryption public key.

Press `f2` to encrypt, `ctrl+t` to switch Text/File, `Tab` to move through output/key, and `Esc` to close. The result
dialog stays open and lets you copy the ciphertext or output path. Results never enter model context.

## Protection plugin integration

At startup and during decryption, the plugin discovers the `register_sensitive_file` tool at runtime and registers:

- the decryption private key: `privateKeyFileForDecrypt`, or the default
  `<keyDirectory>/decrypt-private.pem` when it exists;
- encryption input files;
- decrypted output files.

Once registered, the protection plugin blocks `read` on the private key and replaces private-key content in tool
output and context with `[REDACTED:PROTECTED]`. The encryption plugin's own direct file reads are unaffected. If the
protection plugin is absent, registration is skipped without affecting encryption or decryption.
