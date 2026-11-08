### Communication

Respond in the user's language unless they ask otherwise.

### User- and LLM-Facing Content

Keep user- and LLM-facing documentation and descriptions (for example docs, tools, commands, and skills) concise and
direct. Omit irrelevant implementation details and decision-making history.

### Local OpenCode Testing

For local OpenCode testing, prefer offline testing with `@copilotkit/aimock` when it preserves test fidelity. Route
provider requests through its local server so request details can be inspected and responses mocked.

### Sensitive Data

Never output secrets, tokens, API keys, or credentials into the context; pass them with pipes or environment variables instead.

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

### Playwright Sessions

Use one persistent `main` browser through the global `playwright-cli` so every agent can share the same login at the same time.

```bash
# Use the globally installed CLI.
CLI="$(npm prefix -g)/bin/playwright-cli"
test -x "$CLI" || npm i -g @playwright/cli

# Reuse main, or start it if absent.
"$CLI" list --json | grep -q '"name": *"main"' || "$CLI" -s=main open --headed --persistent --profile="$HOME/.local/state/playwright/profiles/main"

# Reuse this session for every later command.
"$CLI" -s=main goto https://example.com

# Close the tabs you opened.
"$CLI" -s=main tab-close
```

Keep the profile intact and leave my windows untouched. Stay headed unless I explicitly ask for headless. Turn recurring operations into re-runnable scripts — direct network requests and programmatic clicks included — rather than clicking step by step.
