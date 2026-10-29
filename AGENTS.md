# Project Rules

## OpenCode Source Reference

When developing plugins, use the OpenCode source tree to confirm APIs, runtime behavior, and implementation details.

## Plugin Independence and Unicorn Integration

- Every plugin must remain independently usable and must not require another plugin to run. When plugins cooperate,
  include fallbacks for the other plugin being absent.
- Every plugin must also integrate with `plugin-unicorn` (`packages/opencode-plugin-unicorn`) and expose its own
  option so it can be enabled or disabled independently.
- Switches follow the existing `features` pattern. Disabling one plugin must not affect another. Plugins with server
  and TUI entries must honor the corresponding switch on both sides.

## Tool Descriptions

- Tool descriptions must be concise and direct, describing only the purpose and necessary usage limits.
- Parameter meanings and constraints belong in the parameter descriptions, not repeated in the tool description.
- Do not include unrelated implementation details, internal APIs, transport flows, development history, design
  decisions, or rejected alternatives.

## Plugin Version Consistency

- All plugin packages in this repository share one version and are released together.
- New plugins must adopt the current shared version rather than starting at `1.0.0`.

## Publishing

- The only entry point is `npm run release -- --release-type=<type> [--version=<spec>]`.
- `--release-type` must be one of `local-publish`, `local-stage`, `ci-publish`, or `ci-stage`.
- `--version` defaults to `patch` and also accepts `minor`, `major`, or an exact version.
- The script validates arguments, requires a clean worktree, runs the full check, bumps all packages together, and
  then publishes or triggers CI.
- The target version must be strictly greater than every package's registry `latest`.
- Do not call `npm publish` directly. Never commit `~/.npmrc` or any npm token.
