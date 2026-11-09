# OpenCode Plugins Monorepo

**English** | [简体中文](README.zh-CN.md)

A Bun workspace monorepo for a collection of OpenCode plugins.

## Packages

- [`@max10240/opencode-plugin-unicorn`](./packages/opencode-plugin-unicorn): Meta-package that assembles the plugins below; the published name is unchanged.
- [`@max10240/opencode-plugin-send-message-across-sessions`](./packages/opencode-plugin-send-message-across-sessions): send messages between sessions in different working directories.
- [`@max10240/opencode-plugin-prompt-search`](./packages/opencode-plugin-prompt-search): cross-session prompt reverse search for the TUI.
- [`@max10240/opencode-plugin-session-search`](./packages/opencode-plugin-session-search): search user and agent messages in the current session and jump to a result, including saved pre-compaction history.
- [`@max10240/opencode-plugin-image-gen`](./packages/opencode-plugin-image-gen): generate or edit images through standard `/images/*` endpoints.
- [`@max10240/opencode-plugin-notepad`](./packages/opencode-plugin-notepad): capture and manage folder-scoped or global notes without interrupting a session.
- [`@max10240/opencode-plugin-show-img`](./packages/opencode-plugin-show-img): preview server-side images by ID over a UI-only RPC without adding image content to model context.
- [`@max10240/opencode-plugin-sensitive-encrypt`](./packages/opencode-plugin-sensitive-encrypt): encrypt files under `$TMPDIR` with a configured public key and decrypt them with a separate private key.
- [`@max10240/opencode-plugin-sensitive-protection`](./packages/opencode-plugin-sensitive-protection): register protected files and block or redact them before they reach model context.
- [`@max10240/opencode-plugin-recomended-opencode-config`](./packages/opencode-plugin-recomended-opencode-config): optionally add recommended global rules and inline commands, and set `store:false` on existing OpenAI configuration.

## Development

```bash
bun install
bun run build
bun run typecheck
bun run check
```

### Test entry points

| Command | Use when | Scope |
| --- | --- | --- |
| `bun run check:quick` | fast local iteration | Build, typecheck, unit and render tests; no E2E or packaged validation |
| `bun run check` | before pushing or opening a PR | All unit, render, E2E, and packaged tests; build/typecheck/pack artifacts may be reused |
| `bun run check:release` | before publishing | Same complete suite as `check`, but no cache reuse and phases run serially |
| `bun run test` | source-test debugging only | Unit, render, and source E2E; no typecheck or packaged validation |
| `bun run test:unit` | unit/render only | Unit tests and headless TUI rendering; no build and no OpenCode process |
| `bun run test:e2e` | E2E only | One build, source-level server/TUI E2E |
| `bun run test:packaged` | tarball debugging only | Tarball structure, manifest, exports, and file-list validation |

Naming rules:

- `check` is the complete everyday gate.
- `check:quick` is intentionally incomplete and must never be used as a release gate.
- `check:release` is the complete uncached release gate; releases call it directly.
- `test*` commands are scoped test subsets, not full gates.

`bun run check` always executes every test file; test results are never reused across runs. Only build outputs,
typecheck results, and packed tarballs are content-addressed and reused when their inputs are unchanged.
`check:release` bypasses every cache and runs the same complete suite, so cross-plugin regressions are always checked
before publishing. No check or release stage runs `npm install`.

Workspace artifacts are built and packed exactly once per round, in workspace dependency order. Test files use
isolated roots, servers, databases, HOME, and tmux sockets; only the warm TUI file intentionally reuses one prewarmed
server/TUI for its sequential interaction tests. A build or archive hash mismatch fails the run instead of using stale
output. E2E uses a weighted scheduler: the warm TUI pair serves fast interaction tests, render tests exercise plugin UI
behavior in-process, and headless server tests cover API and delivery semantics. Long scenarios no longer depend on a
cold tmux startup for every assertion. Each phase reports its actual duration.

Packaged validation only runs `npm pack` and inspects the resulting tarballs: allowed file list, manifest version,
exports, and expected dist files. It never creates a consumer `node_modules` or runs `npm install`. `check` and
`check:release` run this validation every time; packed archives may be reused, but the validation test always executes.

The content-addressed check cache includes external dependency declarations, Node/npm/Bun versions, platform, and
architecture. Local package versions and code bytes are excluded from resolution identity, while local source and
build hashes determine whether work reruns. The default cache directory is `opencode/unicorn-test-cache` under the
system temporary directory; set `UNICORN_TEST_CACHE_DIR` to a writable directory and cache it in CI. Use
`check:release` for an uncached full run. The check workflow never reads user npm credentials or preload scripts.

Production `npm pack` / `npm publish` still runs the prepack build and rules sync; Unicorn also syncs internal
dependency versions. Only test archives that already validated this round's build skip repeated lifecycle scripts.

Run a single workspace:

```bash
bun run --cwd packages/opencode-plugin-unicorn test
bun run --cwd packages/opencode-plugin-unicorn typecheck
```

Workspace configuration lives in the root `package.json` under `workspaces`. Each package keeps its own entry points,
dependencies, tests, and publish configuration.

All plugin packages share one version. New plugins must adopt the current Unicorn version instead of starting at
`1.0.0`. `bun run check:versions` validates this independently; builds and full checks also verify it automatically
and fail on mismatched versions or internal dependencies that are not pinned exactly. After a version bump, run
`bun run sync:versions` to update internal dependencies.

Recommended rules use a hard link from the repository `rules/AGENTS.md`. `bun install` installs a pre-commit hook,
and commits and prepack runs re-sync the link; `bun run sync:rules` syncs manually. Existing Git hooks are never
overwritten. Command collection reads the `commands` field from the source JSONC plus Markdown files under
`.commands/`, `command/`, and `commands/` in the same directory. It does not copy full configuration or execute
templates, and same-name user commands are not overwritten.

All packages compile NodeNext source into the Git-ignored `dist/`. npm tarballs contain only `package.json`,
`README.md`, `README.zh-CN.md`, and `dist/**/*.js`; they never publish `.ts`, `.tsx`, or declaration files.
`check` runs the complete suite with build/typecheck/pack cache reuse; `check:release` runs the same suite without
cache reuse and is the authoritative release gate. Plugin UI behavior is covered primarily by headless render tests,
with one warm tmux TUI smoke for interaction, reactive filtering, and cross-filesystem image previews. The release
script runs `check:release`, which includes the pack-only tarball validation, before changing versions or uploading.

### Publishing

There is one release entry point, and the release type is required:

```sh
npm run release -- --release-type=<type> [--version=<spec>]
```

Supported `--release-type` values:

| Type | Behavior | 2FA |
| --- | --- | --- |
| `local-publish` | Build and publish locally | Browser security key |
| `local-stage` | Build and stage locally; approve on npm | 2FA when approving |
| `ci-publish` | Commit and push locally; GitHub Actions builds and publishes | OIDC |
| `ci-stage` | Commit and push locally; GitHub Actions builds and stages | 2FA when approving |

`--version` defaults to `patch` and also accepts `minor`, `major`, or an exact version such as `1.2.3`. The target
must be strictly greater than every package's registry `latest` and must not be lower than the local version.

The script:

1. Validates all arguments.
2. Requires a clean worktree; only `rules/` sync files may be uncommitted.
3. Runs the full `npm run check`.
4. Bumps all packages to the target version and syncs internal dependencies.
5. Publishes locally or triggers CI according to the release type.
6. For `local-publish`, commits the package version changes after a successful npm publish.

Local publishing:

```sh
npm run release -- --release-type=local-publish
npm run release -- --release-type=local-stage --version=minor
```

Local publishing runs npm through a pseudo-terminal and prints npm's web-auth link when login or the publish batch
needs verification. `local-publish` trusts a successful npm publish and does not wait for registry propagation; after
success it stages and commits the `package.json` version changes. `local-stage` leaves the version changes for review.

CI publishing:

```sh
npm run release -- --release-type=ci-publish
npm run release -- --release-type=ci-stage --version=1.2.0
```

`ci-*` modes commit the version change and push `main`; the commit message contains `[release]` or
`[release:stage]`. CI never bumps the version.

Staged releases can be reviewed at `https://www.npmjs.com/settings/~/staged-packages`, or with
`npm stage list` and `npm stage approve <stage-id>`.

`local-publish` commits the version changes automatically after npm reports success. `local-stage` does not commit;
review the staged package and commit the version changes when ready. `ci-*` commits and pushes them automatically.
The first publish of a new package cannot use OIDC; use `local-publish` or `local-stage`.
