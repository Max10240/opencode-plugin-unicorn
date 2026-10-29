# @max10240/opencode-plugin-prompt-search

**English** | [简体中文](README.zh-CN.md)

Cross-session prompt reverse search for the OpenCode TUI.

## Usage

TUI plugins are configured in the V2 `cli.json`:

```jsonc
{
  "plugins": [
    {
      "package": "@max10240/opencode-plugin-prompt-search",
      "options": {
        "keybind": "ctrl+shift+r",
      },
    },
  ],
}
```

The default shortcut is `ctrl+shift+r`, chosen to avoid OpenCode defaults. You can also load it through the Unicorn
TUI entry:

```jsonc
{
  "plugins": [
    {
      "package": "@max10240/opencode-plugin-unicorn",
      "options": {
        "features": {
          "promptSearch": true,
        },
        "promptSearch": { "keybind": "ctrl+shift+r", "maxPrompts": 2000 },
      },
    },
  ],
}
```

Results come from user prompts in all sessions visible to the OpenCode server. The index refreshes incrementally by
session update time and is cached in TUI storage. Cached prompts remain searchable after their session disappears
from the server, so deleted sessions can still be searched and the cache survives TUI restarts. If a session is
deleted before the plugin indexes it, the OpenCode API can no longer export it and the index cannot be rebuilt.
Selecting a result inserts the original prompt at the cursor without submitting it.

The cache keeps the latest 2000 user prompts by default; change it with the `maxPrompts` option. Deleting a source
session does not immediately clean the cache, and there is no time-based expiry. When the plugin starts or refreshes
the index above the limit, oldest prompts are evicted first. Setting `0` clears cached prompts and stops retaining
them. Increasing the limit re-indexes sessions that still exist on the server and were previously truncated; prompts
from deleted sessions that were already evicted cannot be recovered.

TUI storage is managed by OpenCode and defaults to `~/.local/state/opencode/<channel>/tui/`; it is not the session
database. Standalone, the index file is
`plugin.max10240.prompt-search.tui.prompt-search.index.json`; through Unicorn it is
`plugin.max10240.unicorn.tui.prompt-search.index.json`. With `XDG_STATE_HOME`, the root becomes
`$XDG_STATE_HOME/opencode`. The plugin reads and writes this file through `context.storage.store`.

```jsonc
{
  "plugins": [
    {
      "package": "@max10240/opencode-plugin-prompt-search",
      "options": { "maxPrompts": 5000 },
    },
  ],
}
```

Plugin options and `keybind` in `cli.json` can be overridden per machine:

```jsonc
{
  "plugins": [
    {
      "package": "@max10240/opencode-plugin-prompt-search",
      "options": { "keybind": "alt+shift+r" },
    },
  ],
}
```

## Testing

```bash
bun test
```

Tests use a temporary OpenCode server and a mock provider; no real model is called.
