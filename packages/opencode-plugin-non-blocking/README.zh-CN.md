# @max10240/opencode-plugin-non-blocking

[English](README.md) | **简体中文**

长时间运行的阻塞型 OpenCode 工具会自动进入后台，无需等待用户按 Ctrl+B。监听和计时逻辑完全在 TUI 端运行，
Server 入口为空操作。

## 行为

- 监听 TUI 能观察到的所有 session 中的前台 `shell` / `bash` 和 `subagent` / `task` 工具调用，包括 subagent 子 session。
- 工具默认运行满 10 秒后，对该工具所属 session 调用与 Ctrl+B 相同的 `session.background` API。
- 该 API 是 session 级别的。同一 session 有多个阻塞工具时，可能一起被放入后台；这是预期行为。
- 每个工具独立计时；在到期前完成的工具不会处理。
- 用户手动按 Ctrl+B 后，相关工具会从监听中移除，插件不会再次处理。
- 以 `background: true` 启动的工具本来就在后台，会被忽略。
- MCP 工具、自定义工具、question 等其他等待型工具无法通过 OpenCode API 放后台，本插件不监听、不处理。
- 不增加面板或常驻 UI。重试后仍然失败时，该 session 会显示一次 warning toast。

## 配置

独立使用：

```jsonc
{
  "plugins": [
    {
      "package": "@max10240/opencode-plugin-non-blocking",
      "options": { "thresholdMs": 10000 }
    }
  ]
}
```

`thresholdMs` 是进入后台前的最短前台运行时间，默认 `10000`。

Unicorn 默认启用。可用 `features.nonBlocking: false` 独立关闭，或通过 `options.nonBlocking.thresholdMs` 配置阈值。

## 性能

- 事件驱动，不轮询 session 历史。
- 每个运行中的阻塞工具只有一个 timer。
- 工具结束、session 删除或插件卸载时立即清理 listener 和 timer。
- 不渲染任何 UI。
- 后台调用失败时使用退避重试，不做高频轮询。

## 兼容性

插件使用现有的 `session.background` API，不需要修改 OpenCode 源码。由于该 API 是 session 级别的，当同一 session
有多个阻塞工具同时运行时无法只选择其中一个；插件因此以 session 作为后台化单位。
