# Test performance validation

**English** | [简体中文](test-performance.zh-CN.md)

2026-11-08, macOS arm64, 8-core host, Bun 1.4.4. Timings are samples from the test host, not a cross-machine
performance guarantee.

## Current entry points

| Command | Use when | Typical duration |
| --- | --- | --- |
| `bun run test:unit` | unit/render only | about 5 s |
| `bun run check:quick` | fast local iteration | about 7–8 s |
| `bun run check` | complete cached everyday gate | about 19–22 s |
| `bun run check:release` | complete uncached release gate | about 40–42 s |
| `bun run test:packaged` | tarball debugging only | about 0.4 s |

`check:quick` intentionally excludes E2E and packaged validation. `check` and `check:release` both execute every
unit, render, E2E, and packaged test. The only difference is cache reuse and phase ordering; test results are never
reused across runs.

## Test layering

- One warm server/TUI file covers real terminal interaction for notepad, prompt search, session search, encryption,
  and image previews. The file takes about 6.5–7 s; individual test bodies take about 0.14–0.9 s.
- Render tests cover plugin UI behavior in-process without a server or tmux.
- Headless server tests cover session-search history, compaction, revert, and delivery semantics. The session-search
  controller E2E takes about 0.9 s.
- send-message no longer uses tmux; it runs a real server plus `opencode run` subprocesses and shares only the
  read-only extracted package tree between modes.

## What is cached

Only build outputs, typecheck results, and packed tarballs are content-addressed. Test results are not cached and no
test is skipped because it passed previously. `check:release` bypasses every cache and serializes phases to avoid
cold-cache contention.

No check or release stage runs `npm install`. Packaged validation only runs `npm pack` and inspects the resulting
tarballs.

## Variance

The host also runs other applications, so `check` timing varies. Clean runs reached 18.6–19.5 s; busier runs reached
22–28 s. The uncached `check:release` run is more stable because its phases are serial.
