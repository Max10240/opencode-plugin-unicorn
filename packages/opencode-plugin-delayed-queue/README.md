# opencode-plugin-delayed-queue

Queue a message now, run it later: only when the session is truly idle and its
background work has finished.

The official queue delivers at the next turn boundary and does not inspect background work. Delayed Queue keeps its
messages in the plugin until `experimental.idle` reports that the session is about to go idle with no relevant
background shell, subagent, image, video, or code-mode job. Work owned by a descendant session is rechecked until that
descendant is quiet.

## Usage

- `/delayed-queue <message>` or `/delay <message>` adds a message to the current session's delayed queue.
- The pending bar appears above the composer, in the same place and style as the official queued-prompt bar.
- Click the bar, or run `/delayed-queue` with no message, to open the management panel.
- In the panel, press `enter` or `ctrl+s` to steer now, `ctrl+d` twice to delete, and `ctrl+p` to pause or resume the whole queue. Typing letters stays in the search field.

A delayed message is delivered as a normal user prompt, so it appears in the transcript like an official queued
message. The queue is stored per session and survives hot reloads and server restarts; a restarted process restores it
paused.

## Trigger rules

Delivers when all of these are true:

- the session completed a turn normally, or the session is already idle and a new message was queued;
- no relevant background job owned by the session is running;
- no relevant background job owned by a descendant is still running (optional, on by default);
- the queue is not paused.

Does not deliver:

- while the session is running;
- while a watched background job is running;
- after a user interrupt or an execution failure, until the next normal user prompt or an explicit resume;
- for control-only idle boundaries such as a manual compaction;
- when the message was already delivered; interrupting that turn does not restore it to the queue.

## Options

```jsonc
{
  "delayedQueue": {
    "enabled": true,
    "keybind": "<leader>d",
    "queueKeybind": "f9",
    "recheckMs": 5000,
    "waitKinds": ["shell", "subagent", "image", "video", "codemode"],
    "waitDescendants": true,
    "pauseOnInterrupt": true,
    "pauseOnFailure": true
  },
  "features": { "delayedQueue": false }
}
```

- `keybind`: opens the management panel. `queueKeybind`: queues the composer text. Set either to `false` to disable it. The slash command and dock still work.
- `recheckMs`: how often descendant-owned background work is re-evaluated.
- `waitKinds`: background kinds that block delivery.
- `waitDescendants`: also wait for work owned by child sessions.
- `pauseOnInterrupt` / `pauseOnFailure`: pause the queue after a user interrupt or execution failure.

## Notes

- Uses the experimental `experimental.idle` session hook. On versions without it, the plugin disables itself.
- The plugin does not hold the idle hook open while waiting; it returns and lets the runner wake it again.
- A daemon that never exits keeps its queue waiting. Delete the message or steer it now from the panel.
