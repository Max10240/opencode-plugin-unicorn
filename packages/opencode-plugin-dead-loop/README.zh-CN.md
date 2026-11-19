# opencode-plugin-dead-loop

让会话持续工作。为你激活它的会话在空闲时等待一个短暂的安静窗口，然后发送一条 nudge
消息，让 agent 持续推进，直到配置的时间窗结束。

## 工作方式

- 通过 TUI 按会话激活，不影响其他对话。
- 每次空闲边界先检查后台任务：后台 Bash、子 Agent、图像/视频任务、code-mode 任务都视为忙，
  运行期间不发送 nudge。会话自己的后台任务结束时框架会唤醒会话并重新评估；挂在子会话名下
  的任务则由定时器持续复查，直到该子会话安静。
- 没有后台任务时打开安静窗口（默认 3 秒）。窗口内出现任何新输入——你打字、跨会话消息、
  steering——都会取消本次 nudge。
- 窗口安静结束且会话仍然空闲时，把配置的文本作为用户消息发送。每轮结束后循环重复，直到
  任务的时间窗到期。到期绝不打断正在运行的 turn。
- 任务只存在于内存：没有历史记录，服务重启后任务消失。

## 用法

- `/deadloop 2h` 为当前会话启动 2 小时的时间窗。
- `/deadloop`（或默认键位 `ctrl+shift+l`）打开面板：预设档位（15m、1h、2h、3h、8h、1d）、
  自定义时长（`90m`、`1h30m`、`2d12h`，纯数字按小时）、实时倒计时，`d` 停止。
- 边界：默认 5 分钟到 7 天；超界输入会被拒绝并提示合法范围。

## 配置

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

- `message`：每次 nudge 发送的文本。
- `delayMs`：空闲后的安静窗口（100–600000）。
- `recheckMs`：复查子会话后台任务的间隔。
- `defaultDurationMs`：自定义输入为空时使用的默认时长。
- `minDurationMs` / `maxDurationMs`：自定义时长允许的范围。
- `presets`：面板快捷档位；加载时校验，非法项会被拒绝。
- `keybind`：默认键位，设为 `false` 关闭键位绑定（slash 命令仍可用）。
- `features.deadLoop: false`（或 `enabled: false`）在 server 与 TUI 两侧同时关闭本插件。

## 说明

- 使用实验性的 `experimental.idle` 会话 hook，需要 OpenCode 2.3 或更新版本。旧版本上插件
  自行禁用，面板显示不可用。
- 失败或被中断的 turn 不会触发该 hook，循环会暂停；你下次发言后自动恢复。
