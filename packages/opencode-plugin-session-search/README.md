# @max10240/opencode-plugin-session-search

**English** | [简体中文](README.zh-CN.md)

Search user and agent text in the current session and jump to the matching message or text part. It never inserts,
submits, or resends a prompt.

## Usage

Load it in the global `cli.json`; it can connect to a local or remote server independently:

```jsonc
{
  "plugins": [{ "package": "@max10240/opencode-plugin-session-search", "options": { "keybind": "ctrl+shift+f" } }]
}
```

The default shortcut is `Ctrl+Shift+F`; the command **Search current session** is also available in the command
palette. Type to filter, use ↑/↓ to select, Enter to jump, and Esc to close. Press Esc during navigation to cancel.
Matching is case-insensitive, and whitespace-separated words are combined with AND. Up to 100 matches are shown;
continue typing to narrow the results.

Unicorn enables it by default and supports `features.sessionSearch:false`. Set the shortcut with
`options.sessionSearch.keybind`; that object is passed to the plugin unchanged and is never mixed with
`options.promptSearch.keybind`. The server entry has no side effects and does not require prompt-search.

## History, compaction, and privacy

- Reads all saved history for the current session page by page; the search scope is not limited to recently loaded
  messages or model context.
- Real compacted user/agent messages remain searchable and navigable. "Before compaction" means the message is older
  than the latest compaction. Compaction summaries are not treated as original dialogue; hidden reasoning, tool
  output, and attachment bytes are not indexed.
- Matches after a revert boundary are marked non-navigable. Navigation never cancels a revert or modifies the session.
- Queued but undelivered prompts are marked non-navigable and are never sent by selecting a search result.
- Content deleted on the server cannot be recovered. Switching sessions, closing the TUI, or disabling the plugin
  cancels related work. The index is memory-only and is not persisted.

## Performance and compatibility

The first open paginates the index with at most two concurrent requests; history is not fetched on every keystroke.
An unchanged full index is reused, streaming updates merge the current message, and queries run in batches with stale
results cancelled. Long text is indexed without truncation; previews and result counts are bounded.

Mounted targets are located after clearing the host navigation cursor, without loading everything. Older messages
are loaded through built-in history navigation and located after mounting. The host has no public message-ID jump
API; the plugin uses renderer message anchors and built-in navigation without modifying Core. The first jump to a
distant message may require O(N) loading/mounting, and very long sessions do not guarantee constant latency. The
plugin targets the start of a message or text part and does not promise exact character-line positioning inside long
Markdown. If navigation support is missing, a message disappears, or the session changes, the operation is
cancelled or reported and never restores or rewrites history.

Validated with OpenCode `v2.0.21` and `v2.1.0` in the real TUI and with npm packages; other versions are not yet
verified.

Background evidence and real TUI validation are documented in
[`research/session-search-feasibility.md`](../../research/session-search-feasibility.md).
