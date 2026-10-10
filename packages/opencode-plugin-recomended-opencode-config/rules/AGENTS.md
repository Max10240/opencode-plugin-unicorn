### Think in Chinese and respond to the user in Chinese.

### User- and LLM-Facing Content

Keep user- and LLM-facing documentation and descriptions (e.g., docs, tools, commands, and skills) concise and direct. Omit irrelevant implementation details and decision-making history.

### Safely Modify OpenCode Configuration

Live configuration is hot-reloaded by all sessions, so direct edits can expose a partially written or invalid file and disrupt every session. When changing `~/.config/opencode/opencode.json[c]`:

1. Record the target file as a baseline; never edit it directly.
2. Validate the replacement with a temporary config directory and standalone mode:
   ```sh
   OPENCODE_CONFIG_DIR=/path/to/temp opencode run --auto --standalone 'hi'
   ```
3. Before `mv`, confirm the target still matches the baseline. If it changed, reconcile first.
4. Move the replacement into place only after validation passes.
