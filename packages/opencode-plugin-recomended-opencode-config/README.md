# @max10240/opencode-plugin-recomended-opencode-config

**English** | [简体中文](README.zh-CN.md)

Merge recommended global rules and commands into an existing OpenCode configuration, and set
`providers.openai.settings.store:false` when OpenAI is already configured. It does not change model limits or
`share`, register tools, or depend on Unicorn.

## Enabling

An explicit `enabled:true/false` takes priority over the environment variable. When no option is set, the server
environment's `IS_MAX_SELF` must be non-empty and not `0` or `false`. Values are trimmed before comparison and
`false` is case-insensitive; every other case disables the plugin.

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [{
    "package": "@max10240/opencode-plugin-recomended-opencode-config",
    "options": { "enabled": true }
  }]
}
```

Unicorn passes `options.recommendedOpencodeConfig` through unchanged, for example `{ "enabled": true }`.
`options.features.recommendedOpencodeConfig: false` forces the plugin off; otherwise the rules above apply. Disabling
the plugin does not remove rules or settings that were already written.

## Merge behavior

- Markdown is parsed with Marked. Rule data is `{ title, description? }`; heading depth is not retained.
- Recommended rules are added under `Addtional Recommended Rules`, created or reused at the highest heading level in
  the user's `AGENTS.md`.
- Equal titles are skipped without comparing depth or overwriting existing content; `#` inside code blocks is not a
  heading.
- With no headings, a level-one container is used. When the container is already level six, rules are represented as
  a list instead of invalid level-seven headings.
- Recommended inline and Markdown commands are synced. Same-name user commands (including global Markdown commands)
  are not overwritten; missing commands are added to inline `commands` while preserving `template`, description,
  agent, model, and argument placeholders.
- No OpenAI key is created. `opencode.jsonc` is created only when commands are missing and no configuration file
  exists.
- JSONC comments and unrelated settings are preserved, and repeated runs do not change file timestamps. Provider
  settings do not override explicit model or variant settings.
- Update failures are warnings and do not prevent other Unicorn plugins from starting.
- When an unclosed code or HTML block makes a safe merge impossible, rules are skipped without repeated appends;
  commands and `store` updates continue. Symlinked configuration is updated at the target while preserving the link.

The global directory follows `OPENCODE_CONFIG_DIR`, then `$XDG_CONFIG_HOME/opencode`, then `~/.config/opencode`.

## Recommended template and hard link

The repository `rules/AGENTS.md` is hard-linked to the global `~/.config/opencode/AGENTS.md` used for local
maintenance. `bun run sync:rules`, the Git pre-commit hook, and each package's prepack re-create the link and collect
top-level `commands` from `opencode.jsonc` plus Markdown commands under `.commands/`, `command/`, and `commands/` in
the same directory into `rules/commands.json`. Full configuration is never stored. Markdown bodies become templates
and preserve frontmatter such as description, agent, model, and subagent; nested files such as `team/review.md`
become `team/review`. Shell commands in templates are not executed. Same-name commands are overridden in the order
inline → `.commands/` → `command/` → `commands/`. `{env:...}` and `{file:...}` in Markdown remain literal; existing
inline commands keep Core's configuration variable expansion.

Set `RECOMMENDED_RULES_SOURCE` or `RECOMMENDED_COMMANDS_SOURCE` to change the sync source, and
`RECOMMENDED_COMMANDS_DIR` for a separate Markdown directory. When every source is missing, the committed templates
are used. When a source exists, recommendations removed from it are removed here; parse failures keep the previous
snapshot and report an error.

Git stores file contents, not link paths, so a fresh clone must re-create the hard link. Published packages embed
recommended rule content in JavaScript; users do not need the repository directory, and no complete
`opencode.json[c]` is included. Never place credentials in rules or command templates.

`bun install` installs `.githooks` for new clones. Existing local/global `hooksPath` or pre-commit hooks are reported
but never overwritten or blocked; in that case wire `scripts/sync-recommended-rules.mjs` into the existing hook or run
`bun run sync:rules` before committing.

## Verification

`bun run check` covers Markdown/JSONC unit tests, hard-link and prepack tests, real OpenCode enable/disable matrices,
configuration hot reload, restart idempotency, rules and `store:false` in model requests, and npm tarball
installation. Tests use isolated directories and local mocks.
