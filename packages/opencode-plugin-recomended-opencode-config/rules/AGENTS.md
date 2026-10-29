### Communication

Respond in the user's language unless they ask otherwise.

### User- and LLM-Facing Content

Keep user- and LLM-facing documentation and descriptions (for example docs, tools, commands, and skills) concise and
direct. Omit irrelevant implementation details and decision-making history.

### Local OpenCode Testing

For local OpenCode testing, prefer offline testing with `@copilotkit/aimock` when it preserves test fidelity. Route
provider requests through its local server so request details can be inspected and responses mocked.

### Safely Modify OpenCode Configuration

Live configuration is hot-reloaded by all sessions, so editing it directly can expose a partially written or invalid
file and disrupt every session. When changing `~/.config/opencode/opencode.json[c]`:

1. Record the target file as a baseline; never edit it in place.
2. Validate the replacement with a temporary configuration directory and standalone mode:
   ```sh
   OPENCODE_CONFIG_DIR=/path/to/temp opencode run --auto --standalone 'hi'
   ```
3. Before moving it into place, confirm the target still matches the baseline. If it changed, reconcile first.
4. Replace the target only after validation passes.
