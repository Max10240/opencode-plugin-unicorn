# @max10240/opencode-plugin-non-blocking

[English](README.md) | **简体中文**

**Agent 跑长命令时，你不必干等。**

构建要两分钟，测试要五分钟，研究型 subagent 一去就是十几分钟。这段时间里，当前 session 被前台任务占着，
Agent 没空开始别的事。OpenCode 其实留了手动出口：按 Ctrl+B 可以把任务移到后台。问题是，每次都得你自己注意到、
停下手头的事、再按一下。

这个插件替你按。前台工具运行到设定时间后，Bash 和 subagent 会自动转入后台，Agent 马上可以接受你的下一条指令。

## 什么时候需要它

- 你经常跑长构建、完整测试、lint、依赖安装或数据处理。
- 你用 subagent 做调研，希望主 session 始终保持可响应。
- 你习惯在 Agent 工作时切换任务，不想等当前工具调用结束。
- 你总是忘记 Ctrl+B 的存在。

如果你的命令通常一两秒就结束，那大概率不需要这个插件。

## 它能给你什么

- **不用再守在键盘前。** 阻塞任务默认运行十秒后自动进入后台。
- **Agent 能更快处理下一件事。** 上一个任务在后台跑，你可以先把下一个请求排上。
- **每个工具独立计时。** 在到期前完成的命令完全不受影响。
- **尊重你的手动操作。** 如果你自己按了 Ctrl+B，插件会立刻忘掉这个工具，不会再次处理。
- **Subagent 同样覆盖。** subagent 子 session 里的阻塞工作也会被监听。
- **不需要学新东西。** 转入后台后的行为和手动按 Ctrl+B 完全一样，完成时照常通知你。

## 快速开始

插件运行在 TUI 端，在 `cli.json` 中加载：

```jsonc
{
  "$schema": "https://opencode.ai/v2/cli.json",
  "plugins": [{
    "package": "@max10240/opencode-plugin-non-blocking",
    "options": { "thresholdMs": 10000 }
  }]
}
```

使用 Unicorn 时默认已开启：

```jsonc
{
  "plugins": [{
    "package": "@max10240/opencode-plugin-unicorn",
    "options": {
      "features": { "nonBlocking": true },
      "nonBlocking": { "thresholdMs": 10000 }
    }
  }]
}
```

用 `features.nonBlocking: false` 可以单独关闭。

## 配置

| 参数 | 默认值 | 作用 |
| --- | --- | --- |
| `thresholdMs` | `10000` | 工具在前台运行多久后转入后台 |

阈值按你的耐心和工作负载来定。`5000` 响应更积极；`30000` 只处理真正长时间的任务。

## 注意事项

- **只有 Bash 和 subagent 能转后台。** OpenCode 的后台能力对应 `shell` / `bash` 和 `subagent` / `task`。MCP 工具、
  自定义工具、question 等其他等待型工具没有后台接口，本插件不会处理。
- **后台化以 session 为单位。** 同一个 session 里有多个阻塞工具时，可能一起进入后台，这与手动 Ctrl+B 的行为一致。
- **不会取消任务。** 转入后台的命令会继续运行，之后可以像其他后台任务一样查看。
- **已经在后台的任务会被忽略。** 以 `background: true` 启动的工具不会重复处理。
- **失败时保持安静。** 如果重试后 OpenCode 仍无法转入后台，TUI 只显示一次 warning，不会反复打扰。
- **不增加新面板或标记。** 插件尽量隐身，原有的后台 UI 会告诉你发生了什么。OpenCode 2.3+ 的核心 TUI 可能不再显示
  Background 标记，但工具仍会正常转入后台，shell 状态和输出不受影响。
