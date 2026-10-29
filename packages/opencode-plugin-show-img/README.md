# @max10240/opencode-plugin-show-img

**English** | [简体中文](README.zh-CN.md)

Show a server-side image to the user with `show_img({ abs_file_path })` without adding image content to model
context.

## Usage

Load the plugin in the OpenCode server's `opencode.jsonc`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["@max10240/opencode-plugin-show-img"]
}
```

The package includes a `./tui` entry. Local servers do not need to enable global image preview settings. When
connecting to a remote server, you can also load the same package in the client's `cli.json` so the client has the
TUI plugin:

```json
{
  "$schema": "https://opencode.ai/v2/cli.json",
  "plugins": ["@max10240/opencode-plugin-show-img"]
}
```

The model only needs:

```json
{ "abs_file_path": "/absolute/path/on/server/image.png" }
```

The TUI renders each preview below its tool output and scrolls with the conversation instead of pinning it next to
the composer. Click a thumbnail or its size label to enlarge it; Esc closes it. The plugin does not read or modify
`session.image_preview` / `prompt.image_preview`, and previews still work when both are disabled. PNG, JPEG, GIF, and
WebP up to 20 MiB are supported; unsupported terminals fall back to colored character blocks through OpenTUI.

Images are read and decoded only when the message row is mounted and near the viewport. Scrolling away, switching
sessions, reverting, or disabling the plugin cancels reads and releases preview resources. Preview depends on host
message-row anchors; collapsed rows that are not mounted or expose no anchor are not shown and do not fall back to a
fixed footer. Validated with OpenCode `v2.0.21` and `v2.1.0`.

When image-gen is enabled, it calls `show_img` after saving to prepare a preview reference, and the TUI also
recognizes preview metadata in `image_gen` results without an extra model tool call. Without image-gen, this plugin's
`show_img` remains usable standalone.

## Data boundary

- Tool input is only a server-side absolute path; `content` is confirmation text, and metadata contains only a random
  ID and filename.
- Server plugin storage persists ID → session, normalized path, MIME type, and filename; image bytes are not stored.
- The TUI obtains the ID from completed `show_img` or `image_gen` metadata and fetches the image through OpenCode's
  authenticated UI-only RPC.
- RPC accepts only an ID and session ID, never arbitrary paths; unknown IDs or mismatched sessions are rejected.
- Base64 image data exists only in RPC transport and client display memory, never in tool results, tool arguments, or
  session dialogue.
- The client never opens server paths, so both sides do not need a shared filesystem. API authentication and remote
  HTTPS/secure tunnels are still required.
- Previews are references, not snapshots: deleting the source file breaks the preview, and changing it may show the
  updated content.
- The tool reports that a preview was prepared; it does not claim that a TUI client displayed it.

This isolates UI and model data flow; it is not a confidentiality sandbox. It does not stop an agent from using
`read`, shell, or other tools to access the same file. File reads use the server process's OS permissions and do not
reuse the built-in `read` per-path permission dialog; do not enable it for untrusted agents.

## Unicorn

Unicorn enables this feature by default; both server and TUI entries can be disabled independently:

```json
{ "features": { "showImg": false } }
```

## Development and testing

```sh
bun run build
bun run test
```

Tests use real OpenCode, tmux, and a local mock model. On macOS, the TUI is denied access to the server image
directory to verify that images still display through RPC, while persisted conversations and subsequent model
requests contain no image content. No real model is called and global user configuration is not modified.

Coverage:

- `test/server-e2e.test.ts`: real tool error paths, four-format RPC, invalid arguments, cross-session rejection,
  server restart, symlink replacement, and file type/change/growth/deletion.
- `test/e2e.test.ts`: standalone and Unicorn switches; real tmux thumbnail/enlarge/Esc/resize, live completion, four
  formats, scroll with conversation and restore, decode/RPC failure recovery, session switching, client hot reload,
  server/client restart, and UI/model content isolation.
- `test/tui/preview.test.tsx`: modeled on OpenCode's `diff-viewer-image.test.tsx`, using OpenTUI `testRender` to check
  actual `ImageRenderable` pixel sizes, scroll clipping, multiple images, virtualization, narrow/wide terminals, error
  recovery, cancellation, and stale-response isolation.
- `test/assets.test.ts` / `test/lifecycle.test.ts`: file boundaries, storage failures, and registration cleanup.
- Root `bun run check` also builds, typechecks, packs and installs every npm package, and repeats the TUI E2E.

Component tests run in a separate browser-condition + Solid preload process; use `bun run test` rather than a bare
`bun test` that bypasses that environment. Cross-filesystem read isolation uses macOS `sandbox-exec`; other platforms
only validate different working directories and RPC transport.
