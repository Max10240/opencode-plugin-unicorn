# @max10240/opencode-plugin-unicorn

**English** | [简体中文](README.zh-CN.md)

**One install. The whole OpenCode toolkit.**

Unicorn bundles this repository's plugins into a single package, with one consistent set of options and independent
switches for every feature. It is for people who want a noticeably better OpenCode without installing, versioning, and
configuring each plugin separately.

## Who it is for

- You want more than one of the plugins below and would rather install them together.
- You run OpenCode on several machines and want the same version and behavior everywhere.
- You like the idea of a toolkit but want to turn individual features off.
- You are setting up a new machine and do not want to assemble the stack by hand.

## Why use Unicorn

- **One package to install and upgrade.** Every feature moves together, so versions never drift apart.
- **One configuration model.** Server and TUI features share the same option names and nested objects.
- **Turn features off independently.** Disable one without touching the others.
- **Start small.** Every bundled plugin also works standalone; Unicorn is a convenience, not a lock-in.
- **Local and remote friendly.** Server features run on the server; TUI features run wherever the TUI runs.

## Quick start

Add Unicorn where the feature belongs:

```jsonc
// opencode.jsonc — server: image generation, image preview, session messaging, notes, security
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["@max10240/opencode-plugin-unicorn"]
}
```

```jsonc
// cli.json — TUI: search, notepad, auto-background, previews
{
  "$schema": "https://opencode.ai/v2/cli.json",
  "plugins": ["@max10240/opencode-plugin-unicorn"]
}
```

When the TUI connects to a remote server, install Unicorn on both sides: the server config controls server features,
and the client's `cli.json` controls TUI features. Server-only plugins do not run in the client.

Everything is enabled by default except the recommended-config plugin. To change a default, use the nested object with
the same name:

```jsonc
{
  "plugins": [{
    "package": "@max10240/opencode-plugin-unicorn",
    "options": {
      "features": { "imageGen": false },
      "nonBlocking": { "thresholdMs": 5000 }
    }
  }]
}
```

## What you get

| Feature | Switch | What it does |
| --- | --- | --- |
| Auto-background | `features.nonBlocking` | Moves long-running Bash and subagent work to the background so you can keep working |
| Prompt search | `features.promptSearch` | Search prompts from all past sessions and insert one without sending it |
| Session search | `features.sessionSearch` | Search the current conversation and jump to a matching message or copy it |
| Cross-session messages | `features.sendMessageAcrossSessions` | Lets one session send a message to another session in a different working directory |
| Image generation | `features.imageGen` | Generates or edits images and saves them as files |
| Image preview | `features.showImg` | Shows images inline without adding image bytes to model context |
| OpenCode Go usage | `features.opencodeGoUsage` | Shows 5-hour, weekly, and monthly usage for every signed-in OpenCode Go account |
| Notepad | `features.notepad` | Folder-scoped and global notes that never interrupt the conversation |
| Sensitive encryption | `features.sensitiveEncrypt` | Encrypts secrets with a public key and decrypts only to a file |
| Sensitive protection | `sensitiveProtection` | `files`, `maxContentBytes`, `notifications`, `historyLimit`, `historyKeybind` |
| Recommended config | `features.recommendedOpencodeConfig` | Adds curated global rules and commands, and sets OpenAI `store:false` |

## Feature configuration

Unicorn passes each same-name nested object to its plugin unchanged. A plugin owns its default values; Unicorn never
renames fields or mixes objects together. Missing objects are passed as `{}`, so every plugin is safe with no options.

| Feature | Nested object | Useful options |
| --- | --- | --- |
| Auto-background | `nonBlocking` | `thresholdMs` (default `10000`) |
| Prompt search | `promptSearch` | `keybind` (default `ctrl+shift+r`), `maxPrompts` (default `2000`) |
| Session search | `sessionSearch` | `keybind` (default `ctrl+shift+f`) |
| Cross-session messages | `sendMessageAcrossSessions` | No required options |
| Image generation | `imageGen` | `model`, `baseURL`, `integrationID` |
| Image preview | `showImg` | Toggle with `features.showImg`; no required options |
| OpenCode Go usage | `opencodeGoUsage` | `keybind` (no default binding) |
| Notepad | `notepad` | `keybind` (default `ctrl+shift+n`), `enabled` |
| Sensitive encryption | `sensitiveEncrypt` | `publicKeyFileForEncrypt`, `privateKeyFileForDecrypt`, `maxBytes` |
| Sensitive protection | `sensitiveProtection` | `files`, `maxContentBytes`, `notifications`, `historyLimit`, `historyKeybind` |
| Recommended config | `recommendedOpencodeConfig` | `enabled` |

`features.<name>: false` always wins and disables that feature without affecting the others. A plugin's own disable
option still works, for example `showImg.features.showImg: false` or `notepad.enabled: false`.

OpenCode Go usage is enabled by default but only appears when the current server has an OpenCode Console credential.
Use `/usage-opencode-go`; there is no default keybind.

The recommended-config feature is special: `features.recommendedOpencodeConfig: false` force-disables it, but leaving
the switch unset does not enable it. Turn it on with `"recommendedOpencodeConfig": { "enabled": true }`, or let the
plugin read the server's `IS_MAX_SELF` environment variable.

## Everyday recipes

**Keep the agent moving.** Leave auto-background on and get your session back after ten seconds of a long build or
subagent run:

```jsonc
{ "nonBlocking": { "thresholdMs": 10000 } }
```

**Make privacy the default.** Protect secrets, encrypt sensitive files, and stop OpenAI from storing requests:

```jsonc
{
  "features": { "sensitiveProtection": true, "sensitiveEncrypt": true },
  "recommendedOpencodeConfig": { "enabled": true }
}
```

**Use fewer shortcuts.** Turn off prompt search and session search, keep notepad and auto-background:

```jsonc
{ "features": { "promptSearch": false, "sessionSearch": false } }
```

## Upgrading from flat options

Unicorn no longer reads top-level `model`, `baseURL`, `integrationID`, `keybind`, `shortcut`, `maxPrompts`, or
`sessionSearchKeybind`. Move image options under `imageGen`, prompt-search options under `promptSearch`, and
`sessionSearchKeybind` to `sessionSearch.keybind`.

If you previously enabled the recommended-config plugin with `features.recommendedOpencodeConfig: true`, also set
`recommendedOpencodeConfig.enabled: true`. Standalone plugin configuration is unchanged.

## Learn more

Each feature has its own README with usage examples and edge cases:

- [Auto-background](../opencode-plugin-non-blocking/README.md)
- [Prompt search](../opencode-plugin-prompt-search/README.md)
- [Session search](../opencode-plugin-session-search/README.md)
- [Cross-session messages](../opencode-plugin-send-message-across-sessions/README.md)
- [Image generation](../opencode-plugin-image-gen/README.md)
- [Image preview](../opencode-plugin-show-img/README.md)
- [OpenCode Go usage](../opencode-plugin-opencode-go-usage/README.md)
- [Notepad](../opencode-plugin-notepad/README.md)
- [Sensitive encryption](../opencode-plugin-sensitive-encrypt/README.md)
- [Sensitive protection](../opencode-plugin-sensitive-protection/README.md)
- [Recommended config](../opencode-plugin-recomended-opencode-config/README.md)
