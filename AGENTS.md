# Project Rules

## OpenCode Source Reference

Before consulting OpenCode source, update the checkout at `/Users/max/daily/opencode` to the latest version and use that tree to confirm APIs and runtime behavior.

## Check Commands

- `bun run check:quick`: fast local feedback (build, typecheck, unit/render). Never use it as a release gate.
- `bun run check`: complete everyday gate. Runs every unit, render, E2E, and packaged test; reuses only build,
  typecheck, and packed-tarball artifacts.
- `bun run check:release`: complete uncached release gate. Runs the same test set without cache reuse and serializes
  phases. Releases call this command.
- `bun run test*`: scoped test commands, not complete checks.
- Test results are never cached or skipped. No check or release stage runs `npm install`.

## Local Shadow Snapshot

- Do not run `bun run shadow:update` or `bun run shadow:clean` unless the user explicitly asks. Both change or remove the
  snapshot loaded by the live global OpenCode instance.
- `bun run shadow:status` and `bun run shadow:verify` are read-only checks.

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
  then publishes or triggers CI. `local-publish` commits the package version changes after npm reports success;
  `ci-*` commits and pushes them.
- The target version must be strictly greater than every package's registry `latest`.
- CI release reruns are idempotent: `release-execute` may run for a version that is already `latest`, and packages that
  already exist with matching integrity are skipped. Use `workflow_dispatch` on `main` to rerun a release after a
  transient registry timeout.
- Do not call `npm publish` directly. Never commit `~/.npmrc` or any npm token.
- Local release types (`local-publish`, `local-stage`) run the real release in a detached process. When npm needs
  browser authorization, the foreground command prints the URL and a `--resume <session-id>` command, then exits.
- The agent must run the printed resume command immediately after the first command finishes, without waiting for a
  user reply. The resume command is blocking: it prints any further auth URLs and continues waiting until
  authorization and the release finish. Do not rerun `--resume` for each URL.
- The resumable flow uses `expect` to give npm a pseudo-terminal so it emits web-auth URLs.
- Packages publish in workspace dependency levels, one `npm publish --workspace` batch per level. The next level starts
  after the previous `npm publish` command succeeds; it does not wait for registry propagation. Unicorn is therefore
  published after the dependency packages, without the long visibility wait. `local-publish` also skips the final
  registry verification. This keeps auth challenges to one per level instead of one per package.
- During a release, session inputs and output are kept under
  `/tmp/opencode-plugin-unicorn-release-<uid>/<session-id>/` (`session.json`, `output.log`, `auth-events.jsonl`,
  `done.json`). A successful session is removed immediately after the final result; a failed session is kept for
  debugging.
