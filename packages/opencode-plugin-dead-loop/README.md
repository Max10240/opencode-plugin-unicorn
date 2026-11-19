# opencode-plugin-dead-loop

Keep a session working. When the session you activate it for goes idle, the plugin waits a short
quiet window and then sends a nudge message, so the agent keeps going until the configured time
window ends.

## How it works

- Activate per session from the TUI; other conversations are never affected.
- At every idle boundary the plugin checks background work first: background shells, subagents,
  image or video jobs, and code-mode jobs all count as busy, so no nudge is sent while they run.
  Work the session owns wakes the session when it finishes; work a descendant owns re-evaluates on
  a timer until that descendant is quiet.
- With no background work the plugin opens a quiet window (3s default). Any new input in that
  window — your typing, cross-session messages, steering — cancels the nudge.
- When the window elapses on a still-idle session, the configured message is sent as a user
  message. The loop repeats after each turn until the task's deadline passes. Expiry never
  interrupts a running turn.
- Tasks live in memory only: there is no history, and a server restart clears them.

## Usage

- `/deadloop 2h` starts a two-hour window for the current session.
- `/deadloop` (or the default `ctrl+shift+l` keybind) opens the panel: presets (15m, 1h, 2h, 3h,
  8h, 1d), a custom duration (`90m`, `1h30m`, `2d12h`, bare numbers are hours), live countdown,
  and `d` to stop.
- Bounds: 5 minutes to 7 days by default; out-of-range input is rejected with the closest valid
  value shown.

## Options

```jsonc
{
  "deadLoop": {
    "message": "Keep working without asking any questions. Do not stop until you have finished everything you need to do.",
    "delayMs": 3000,
    "defaultDurationMs": 3600000,
    "minDurationMs": 300000,
    "maxDurationMs": 604800000,
    "presets": ["15m", "1h", "2h", "3h", "8h", "1d"],
    "keybind": "ctrl+shift+l"
  },
  "features": { "deadLoop": false }
}
```

- `message`: the text sent on every nudge.
- `delayMs`: the quiet window after idle (100–600000).
- `recheckMs`: how often descendant-owned background work is re-evaluated.
- `defaultDurationMs`: used when the custom input is empty.
- `minDurationMs` / `maxDurationMs`: accepted custom duration range.
- `presets`: panel shortcuts; invalid entries are rejected at load.
- `keybind`: default keybind, or `false` to disable the binding (slash command still works).
- `features.deadLoop: false` (or `enabled: false`) turns the plugin off on both the server and TUI
  side.

## Notes

- Uses the experimental `experimental.idle` session hook; requires OpenCode 2.3 or newer. On older
  versions the plugin disables itself and the panel reports it as unavailable.
- The hook does not run after a failed or interrupted turn, so the loop pauses there and resumes
  after your next message.
