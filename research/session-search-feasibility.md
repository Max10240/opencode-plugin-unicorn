# Current-session search and scroll positioning: feasibility evidence

**English** | [简体中文](session-search-feasibility.zh-CN.md)

Date: 2026-10-20. Tested with OpenCode v2.0.21 and v2.1.0, plugin SDK 2.0.10, with all model requests using a
localhost mock. The reference source was OpenCode commit `0e12e2e7`; referenced files had no workspace changes.
Source and installed binaries were validated separately.

## Conclusion

This can be implemented in a plugin without modifying Core. There is no public `ui.session.scrollToMessage` API, and
pixel positions cannot be inferred from the message list alone. The implementation uses the public keymap dispatch,
renderer tree, and ScrollBox APIs. Message anchor naming is a host convention and is validated through the real TUI.

| Evidence | Detail |
| --- | --- |
| V2 CLI plugin docs | `https://opencode.ai/v2/docs/build/plugins/cli` exposes renderer, keymap dispatch, session data, and dialogs; it does not declare a dedicated message jump interface. |
| SDK types | `@opencode/plugin/dist/tui/context.d.ts` UI includes dialog/router/tabs/slot; the public renderer can locate renderables. |
| Built-in navigation and loading | `packages/tui/src/routes/session/index.tsx:413-505,829-894` implements tail mounting, history pagination, and First message; unmounted messages cannot be scrolled to directly. |
| Message anchors | `packages/tui/src/routes/session/rows.ts:494-529`: boundary rows use messageID, subsequent parts use `session-part:<messageID>:<partID>`. |
| Host layout wait | `packages/tui/src/routes/session/index.tsx:393-400,700-749` requires layout before positioning; the plugin uses renderer frame events and cannot assume a global requestAnimationFrame inside the plugin sandbox. |
| Full saved-history pagination | `packages/protocol/src/groups/message.ts:8-40,68-85` supports type filters, up to 200 items per page, and opaque cursors; this is not a model context API. |
| Post-compaction display | `packages/tui/src/routes/session/rows.ts:343-410` preserves historical user/agent messages while compaction control messages do not replace the originals. |

## Preliminary experiment

A real TUI imported 150 rounds of user/agent dialogue (450 records). Initially only the last 13 message anchors were
mounted. The target was agent message 40, which was not loaded. After built-in history navigation prepared it, the
ScrollBox moved from tail scroll position 106 to 810, the target `y=1` and viewport `y=1`, and the original text
appeared at the top of the screen.

A real `/compact` then ran; export still contained the target text, and positioning succeeded again with 452 records,
with the target still at the top of the viewport. Searching only model context would miss history, but reading saved
messages makes pre-compaction originals locatable.

## Implementation and validation

- Standalone package `packages/opencode-plugin-session-search`; Unicorn controls it with `features.sessionSearch` and
  a separately configured shortcut.
- The first open reads pages by type with at most two concurrent requests; non-dialogue index data such as tools and
  attachments is discarded per page. Queries do not fetch history.
- One in-memory cache per session; queries yield in batches and cancel stale work; the full conversation is never
  copied into persistent plugin storage.
- Mounted targets are positioned after clearing the old navigation cursor. Unloaded targets reuse `session.first`;
  unmounted targets reuse `session.message.next`, then clear the built-in navigation cursor and position.
- The first long-distance jump may load/mount O(N) messages; there is no dedicated window-position API, so constant
  latency is not promised for very long sessions.
- Positioning targets the start of a message or text part and does not guarantee an exact character line inside a
  long Markdown paragraph.
- Session switches, reverts, deletions, plugin unloads, and cancellations must not publish stale async results into
  another session. Missing capabilities or anchors are reported, never faked as success.

Formal E2E: `packages/opencode-plugin-session-search/test/e2e.test.ts` validates standalone and Unicorn enable/disable
matrices. The enabled case imports 260 dialogue rounds (more than one page per type), runs a real compaction, searches
user and agent originals, selects the 12th off-screen result and the second agent text part, presses Enter, and checks
the real TUI target text while preserving the composer draft and adding no model requests. Coverage also includes
index isolation across session switches, new replies while search is open, staged reverts blocking navigation, and
committed reverts clearing old matches. Unicorn runs with prompt-search and image preview enabled to verify shortcut
isolation and that disabling session-search does not affect prompt insertion. After a jump, built-in previous/next
user-message navigation, return-to-bottom, and new-reply following are verified. Hot-disabling the plugin removes only
its own dialog and does not close replacement dialogs. Compaction summary deltas do not rebuild the dialogue index;
markers refresh only after compaction completes. Packaged E2E repeats UI validation for the standalone plugin and
Unicorn from real npm archives.

An earlier version could leave a valid anchor but time out waiting for a frame during consecutive jumps. The fix
requests the next frame in a new event-loop task instead of repeating requests before the previous frame's scheduled
cleanup. Cancellation/timeout still cleans up listeners and timers. Regression tests and both real TUI versions cover
this behavior.

```sh
bun run build
bun test packages/opencode-plugin-session-search/test/e2e.test.ts
bun run check
```

Final verification:

| OpenCode | Command | Result |
| --- | --- | --- |
| v2.1.0 | `bun run check:fresh` | 267 passed, 0 failed |
| v2.0.21 (isolated binary) | `OPENCODE_BIN=<v2.0.21 binary> bun run check` | 267 passed, 0 failed |

Both rounds include seven-package build/typecheck, unit/headless tests, real server/TUI E2E, clean npm archive
installation, and UI validation. No paid model was called; Core, global configuration, and the running shared service
were not modified. Other OpenCode versions are not yet verified.

Messages already deleted and no longer returned by the server cannot be recovered. Attachments without text, tool
output, hidden reasoning, and compaction summaries are never presented as user/agent originals.
