# @max10240/opencode-plugin-send-message-across-sessions

[English](README.md) | **简体中文**

**让你的 OpenCode session 互相说话。**

真实工作很少能塞进一个目录。你可能一个 session 做前端、一个做后端，或者给不同功能各开一个 worktree。每个 session 都有自己的
上下文，于是你成了传话人：从这边复制发现，贴到那边，反复来回。

这个插件给 Agent 两个和别的 session 通信的工具。它可以列出在线的 session，并按合适的时机发送消息，让并行的工作自己保持同步。

## 什么时候需要它

- 前端和后端 session 需要对齐 API 契约。
- 两个 worktree 在改相关代码，需要共享发现。
- 一个调研 session 发现了另一个实现 session 需要的信息。
- 你想把任务交接给另一个项目，又不想复制一大段总结。
- 你同时跑多个 Agent，希望它们能互相提问。

## 它能给你什么

- **发现 session。** Agent 能看到其他在线 session 的标题、工作目录和状态。
- **像用户一样发消息。** 目标 session 收到一条普通消息，带发送方标记，并在自己的上下文里回应。
- **投递时机可控。** 忙着的 session 可以在下一次工具调用后被打断，也可以等当前回合结束。
- **不用再复制粘贴。** 发现、约束和交接直接在 session 之间流动。
- **几乎不用配置。** 加载插件即可。

## 快速开始

在 server 配置中加载：

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["@max10240/opencode-plugin-send-message-across-sessions"]
}
```

使用 Unicorn 时默认开启：

```jsonc
{
  "plugins": [{
    "package": "@max10240/opencode-plugin-unicorn",
    "options": { "features": { "sendMessageAcrossSessions": true } }
  }]
}
```

## 使用

直接用自然语言告诉 Agent：

> 问一下后端 session，`/users` 接口的响应结构会是什么样，然后把我们的 client 类型改好。

Agent 会用 `list_online_sessions` 找到目标，再用 `send_message_across_sessions` 发送。如果它不知道你指哪个 session，会先把
列表返回给你选择。

### 投递方式

| 模式 | 行为 | 适合 |
| --- | --- | --- |
| `steer`（默认） | 目标正忙时，在当前回合的下一次工具调用后注入；目标空闲时立即开始新回合 | 需要及时协调 |
| `queue` | 等目标当前回合结束后，在下一回合投递 | 不想打断对方 |

## 注意事项

- **两个 session 必须在同一个 OpenCode server。** 插件只能看到它所在 server 上的 session。
- **目标 session 要在插件启动之后启动。** 在线列表来自 session 事件；插件启动前就存在的 session 不会被追溯发现。
- **这是给对等 session 用的，不是给主 Agent 和子 Agent 用的。** 父子任务请用 OpenCode 内置的 subagent。
- **目标收到的是普通用户消息。** 没有隐藏通道；这条消息会成为对方对话的一部分。
- **不需要配置。** 加载后直接让 Agent 去问。
