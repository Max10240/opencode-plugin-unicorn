# opencode-plugin-infinite-loop

让会话持续工作。为你激活它的会话在空闲时等待一个短暂的安静窗口，然后发送一条 nudge
消息，让 agent 持续推进，直到配置的时间窗结束。冷却按“上一次成功 nudge”计算，而不是按
“这次检查”计算。

## 工作方式

- 通过 TUI 按会话激活，不影响其他对话。
- 每次空闲边界先检查实时后台任务：后台 Bash、子 Agent、图像/视频任务。运行期间不发送
  nudge。
- 实时目录由事件维护：会话树、执行状态和 shell 事件增量更新，热路径不扫描会话数据库。
- 没有后台任务时打开安静窗口（默认 3 秒）。窗口内出现任何新输入——你打字、跨会话消息、
  steering——都会取消本次 nudge。
- 每次成功 nudge 后进入冷却。下一次尝试时间 =
  `max(现在 + 安静窗口, 上次 nudge + 冷却)`。例如上次 nudge 在 3 分钟前、冷却为 5 分钟，
  就只再等 2 分钟；到点后重新检查 busy/后台，再决定是否发送。
- 异常结束不会中断循环：turn 失败或系统级中断（shutdown、superseded、inactivity）会从
  执行事件流捕获并重试。
- 只有**你手动打断**才暂停循环，并在你下一个正常完成的 turn 后自动恢复。显式停止
  （面板 `ctrl+d` 连按两次、RPC stop、`ctrl+shift+d` 停止全部）才真正终止任务。
- 任务只存在于内存：没有历史记录，服务重启后任务消失。
- 同一个 OpenCode 进程内所有项目共享 runtime，所以“所有项目”面板能看到并停止全部 Loop。

## 用法

- `/infinite-loop 2h` 为当前会话启动 2 小时的时间窗。
- `/infinite-loop 90m cooldown=10m` 按本次任务覆盖冷却。
- `/infinite-loop`（或 `ctrl+shift+i`）打开面板：可点击的预设档位（15m、1h、2h、3h、8h、1d）、
  自定义时长（`90m`、`1h30m`、`2d12h`，纯数字按小时）、自定义冷却（`5m`、`1h`、`0`，
  纯数字按分钟）、实时状态，`ctrl+d` 连按两次停止。
- `/infinite-loops`（或 `ctrl+shift+o`）打开“所有项目”面板。任意面板内 `ctrl+a` 可在
  “当前会话”和“所有项目”之间切换。
- 所有项目面板：`↑/↓` 选择，`ctrl+d` 连按两次停止选中 Loop，`ctrl+shift+d` 停止全部（二次确认），
  `ctrl+r` 刷新，`f1` 帮助，`esc` 关闭。
- 可打印字符始终输入到时长和冷却输入框；面板动作统一使用 Ctrl 组合键，不依赖焦点。
- 边界：默认时间窗 5 分钟到 7 天；冷却 0 到 30 天。超界输入会被拒绝并提示合法范围。
- `f1` 打开键位帮助；`esc` 先关帮助，再关面板。

## 配置

```jsonc
{
  "infiniteLoop": {
    "message": "Keep working without asking any questions. Do not stop until you have finished everything you need to do.",
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

- `message`：每次 nudge 发送的文本。
- `delayMs`：空闲后的安静窗口（100–600000）。
- `recheckMs`：复查后台任务的间隔（100–600000）。
- `cooldownMs`：两次成功 nudge 之间的最小间隔（0–30 天）；`0` 表示关闭冷却。
- `defaultDurationMs`：自定义输入为空时使用的默认时长。
- `minDurationMs` / `maxDurationMs`：自定义时长允许的范围。
- `presets`：面板快捷档位；加载时校验，非法项会被拒绝。
- `keybind` / `overviewKeybind`：全局快捷键，设为 `false` 关闭键位绑定（slash 命令仍可用）。
- `features.infiniteLoop: false`（或 `enabled: false`）在 server 与 TUI 两侧同时关闭本插件。

## 说明

- 使用实验性的 `experimental.idle` 会话 hook，需要 OpenCode 2.3 或更新版本。旧版本上插件
  自行禁用。
- turn 失败或系统级中断不会触发该 hook，循环通过执行事件流和发送后的复查自愈。
- 手动打断任务会话或它的任意子 Agent，会暂停整个任务家族。
- 图像/视频后台任务也视为忙；实时门禁的核心是 Bash 和 Subagent。
