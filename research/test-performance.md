# Test performance validation

**English** | [简体中文](test-performance.zh-CN.md)

2026-10-20, macOS arm64, Node v26.5.0, Bun 1.4.2. Timings are samples from the test host, not a cross-machine performance guarantee.

## Measurements after optimization

| Entry / phase | Duration |
| --- | --- |
| `bun run test:unit`, no build | 0.94 s |
| `bun run check:fast`, including build and typecheck | 10.89 s |
| `bun run check`, OpenCode v2.1.0, dependency cache hit | 65.47 s |
| `bun run check`, OpenCode v2.0.21, dependency cache hit | 70.08 s |
| `bun run check:fresh`, v2.1.0, forced dependency resolution | 123.69 s |
| Unified six-package build / archive in the full check | about 5.0 s / 1.6 s |
| Real `npm ci --offline` during packaged installation | about 1.9–2.0 s |

Before optimization: packaged E2E took 92.93 s, including 7.33 s build, 10.70 s for six packs, and 46.99 s npm
install. After optimization the packaged E2E phase takes about 20.6–21.3 s; unified build/pack moved to earlier
phases, so phase durations are not standalone command totals. The cross-session case dropped from 27.68 s to about
4.9–6.0 s in the full workflow because repeated packing was removed and the earlier archive is reused.

`check:fresh` still needs network access for npm resolution and installation; this run took 57.58 s. It can use the
download cache but does not reuse the cached lockfile or `node_modules`.

## Correctness validation

- Full checks on v2.0.21 and v2.1.0: **238 passed, 0 failed** each; 211 existing tests were preserved and 27 were
  added.
- Unit tests cover build order, concurrency limits, failure propagation, test discovery, renderer conditions, and
  single build/pack execution.
- Source, test, manifest, artifact changes, and artifact deletion invalidate the build ticket; linked source changes
  and directory cycles are covered.
- Archive copies never share writable files, and a corrupt cache cannot produce a successful test.
- Real npm cases verify that code changes under the same plugin version are read by both offline and forced-fresh
  installations.
- Dependency cache key changes, corrupt caches, missing offline dependencies, partial installation cleanup, and
  fresh failures are covered.
