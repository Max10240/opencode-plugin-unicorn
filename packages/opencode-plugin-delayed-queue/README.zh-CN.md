# opencode-plugin-delayed-queue

现在先入队，真正执行要等到会话空闲且后台工作结束。

官方 Queue 在当前轮结束时就会投递，并不检查后台任务。Delayed Queue 会把消息留在插件队列里，直到
`experimental.idle` 确认会话即将空闲，并且没有相关的后台 shell、subagent、图片、视频或 code-mode 任务。
后代会话拥有的后台工作会持续 recheck，直到后代也安静下来。

## 使用

- `/delayed-queue <消息>` 或 `/delay <消息>`：把消息加入当前会话的延迟队列。
- 输入框上方会出现待投递栏，位置和样式与官方 queued prompt 栏一致。
- 点击该栏，或不带消息运行 `/delayed-queue`，打开管理面板。
- 面板中 `enter` 或 `ctrl+s` 立即 steer，`ctrl+d` 删除当前选中消息，`ctrl+p` 暂停/恢复整个队列；字母输入始终进入搜索框。

## 暂停

`ctrl+p` 暂停或恢复当前会话的整个队列，而不是只作用于选中的那一条。暂停只阻止自动投递，不会删除消息；
`enter` 或 `ctrl+s` 仍可立即 steer 选中的消息。

暂停时面板会显示 `Whole queue paused` 和暂停原因，标题栏会带上 `paused`，输入框上方的待投递栏会显示
`⏸ N delayed · paused`（或简短原因）并使用 warning 色左边框，底部提示变为 `ctrl+p resume queue`，每次暂停或
恢复都会弹出 toast 确认。原因包括 `manually`，以及队列自动暂停时的 `after an interrupt`、`after a failure`、
`after a restart`、`after delivery failures`；旧版暂停状态没有记录原因时显示 `no reason recorded`。

延迟消息最终以普通 user prompt 投递，因此会像官方 queued prompt 一样出现在 transcript 中。队列按会话持久化，
热重载和服务重启后会保留；重启恢复的队列默认暂停。

## 触发规则

满足以下条件才投递：

- 会话正常完成一轮，或会话已经空闲时新入队；
- 当前会话没有相关的后台任务；
- 后代会话没有相关的后台任务（默认开启）；
- 队列未暂停。

以下情况不投递：

- 会话正在运行；
- 被监听的后台任务仍在运行；
- 用户手动打断或执行失败后，直到下一条普通用户消息或显式恢复；
- manual compaction 等 control-only 的空闲边界；
- 消息已经投递过；打断那一轮不会把它恢复到队列。

## 选项

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

- `keybind`：打开管理面板；`queueKeybind`：把输入框内容加入延迟队列；设为 `false` 可禁用。斜杠命令和待投递栏仍可用。
- `recheckMs`：后代后台任务的 recheck 间隔。
- `waitKinds`：会阻塞投递的后台类型。
- `waitDescendants`：是否也等待子会话拥有的后台工作。
- `pauseOnInterrupt` / `pauseOnFailure`：用户打断或执行失败后暂停队列。

## 说明

- 依赖实验性的 `experimental.idle` session hook；运行时不提供该 hook 会自动禁用。
- hook 内不会一直等待后台任务；插件直接返回，让 runner 在后台完成 notice 后再次触发。
- 永不退出的后台进程会让队列一直等待；可以在面板中删除消息或立即 steer。
