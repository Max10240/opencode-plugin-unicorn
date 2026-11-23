# opencode-plugin-infinite-loop

Keep a session working. When the session you activate it for goes idle, the plugin waits a short
quiet window and then sends a nudge message, so the agent keeps going until the configured time
window ends. A cooldown paces reminders from the last nudge, not from the check that noticed it.

## How it works

- Activate per session from the TUI; other conversations are never affected.
- Every idle boundary first checks live background work: background shells, subagents, and image
  or video jobs. No nudge is sent while any of them is still running.
- The live directory is event-driven: session history and shell/execution events keep it current,
  so the hot path never scans the session database.
- With no background work the plugin opens a quiet window (3s default). Any new input in that
  window — your typing, cross-session messages, steering — cancels the nudge.
- A question cannot stall the loop: while a task is active, the `question` tool is rejected with
  `questionMessage`, the agent reads it as feedback, and the turn keeps going. A question from a
  subagent is blocked the same way. Stopping the task lets questions through again.
- Each successful nudge sets a cooldown. The next attempt is scheduled at
  `max(now + quiet, lastNudge + cooldown)`. If the session went idle three minutes ago and the
  cooldown is five minutes, the plugin waits two more minutes, then checks busy/background again
  before sending.
- Abnormal endings keep the loop going: a failed turn, or a system interruption (shutdown,
  superseded, inactivity), is picked up from the execution event stream and the loop retries.
- Only a manual user interruption pauses the loop. It resumes with the next turn that completes
  normally. An explicit stop (panel `ctrl+d` twice, `/` RPC stop, or `ctrl+shift+d` stop all) ends the task.
- Tasks live in memory only: there is no history, and a server restart clears them.
- The runtime is shared across projects in one OpenCode process, so the all-projects panel can
  see and stop every active loop.

## Usage

- `/infinite-loop 2h` starts a two-hour window for the current session.
- `/infinite-loop 90m cooldown=10m` starts with a per-run cooldown override.
- `/infinite-loop` (or `ctrl+shift+i`) opens the panel: clickable presets (15m, 1h, 2h, 3h, 8h, 1d),
  custom duration (`90m`, `1h30m`, `2d12h`, bare numbers are hours), custom cooldown (`5m`, `1h`, `0`,
  bare numbers are minutes), live status, and `ctrl+d` twice to stop.
- `/infinite-loops` (or `ctrl+shift+o`) opens the all-projects panel. Inside any panel,
  `ctrl+a` switches between this session and all projects.
- All-projects panel: `↑/↓` select, `ctrl+d` twice to stop the selected loop, `ctrl+shift+d` stop all
  (with confirmation), `ctrl+r` refresh, `f1` help, `esc` close.
- Printable characters always belong to the duration and cooldown inputs; panel actions are Ctrl
  combinations, so they behave the same regardless of focus.
- Bounds: 5 minutes to 7 days by default; cooldown 0 to 30 days. Out-of-range input is rejected
  with the closest valid range shown.
- `f1` opens keyboard help; `esc` closes help first, then the panel.

## Options

```jsonc
{
  "infiniteLoop": {
    "message": "Keep working without asking any questions. Do not stop until you have finished everything you need to do.",
    "questionMessage": "Don't ask any questions. Keep doing what you think we need most.",
    "blockQuestions": true,
    "delayMs": 3000,
    "recheckMs": 2000,
    "cooldownMs": 300000,
    "defaultDurationMs": 3600000,
    "minDurationMs": 300000,
    "maxDurationMs": 604800000,
    "presets": ["15m", "1h", "2h", "3h", "8h", "1d"],
    "keybind": "ctrl+shift+i",
    "overviewKeybind": "ctrl+shift+o"
  },
  "features": { "infiniteLoop": false }
}
```

- `message`: the text sent on every nudge.
- `questionMessage`: the text the agent receives instead of a question while a task is active.
- `blockQuestions`: reject the `question` tool while a task is active (`true`); set to `false` to let
  the agent ask and wait for you.
- `delayMs`: the quiet window after idle (100–600000).
- `recheckMs`: how often background work is re-evaluated (100–600000).
- `cooldownMs`: minimum time between successful nudges (0–30 days); `0` disables the cooldown.
- `defaultDurationMs`: used when the custom duration input is empty.
- `minDurationMs` / `maxDurationMs`: accepted custom duration range.
- `presets`: panel shortcuts; invalid entries are rejected at load.
- `keybind` / `overviewKeybind`: global shortcuts, or `false` to disable the binding (slash
  commands still work).
- `features.infiniteLoop: false` (or `enabled: false`) turns the plugin off on both the server
  and TUI side.

## Notes

- Uses the experimental `experimental.idle` session hook; requires OpenCode 2.3 or newer. On older
  versions the plugin disables itself.
- Question blocking uses the `tool` `execute.before` hook. Hosts that do not expose tool hooks
  keep nudging but cannot stop questions.
- A question that is already pending when the task starts keeps waiting for you: the hook only
  rejects new calls. Answer or dismiss it once and the task continues without stalling again.
- The idle hook does not run after a failed or interrupted turn. The loop recovers from the
  durable execution events and a post-send recheck.
- A manual interruption of the task session or any of its subagents pauses the whole task family.
- Background image/video work is also treated as busy, even though the plugin's live gate is
  primarily built around Bash and subagents.
