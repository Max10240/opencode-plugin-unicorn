# @max10240/opencode-plugin-retry

[English](README.md) | **简体中文**

模型卡住时，按 `F5` 打断当前回合并发送可配置的 `Continue`。

## 作用

按 `F5`，或提交 `/retry `（slash 形式不带参数，末尾需要空格）。不提供面板，也不注册命令面板入口。

- 当前会话空闲：直接发送 `Continue`。
- 当前会话正在运行：先打断，等待打断真正结束，再发送 `Continue`。
- 打断后 1 秒仍未结束：不发送任何消息，并在右上角弹出 Retry 失败提示。
- 不会打开任何面板。

阻塞判断只看当前会话的执行状态（`running` / `idle`）。主回合已经 idle、但后台 shell 或 subagent 还在跑时，
不算阻塞。

## 配置

这是 TUI 插件，配置写在 `cli.json`。

独立使用：

```jsonc
{
  "$schema": "https://opencode.ai/v2/cli.json",
  "plugins": [
    {
      "package": "@max10240/opencode-plugin-retry",
      "options": {
        "keybind": "f5",
        "continueText": "Continue"
      }
    }
  ]
}
```

通过 Unicorn 使用：

```jsonc
{
  "$schema": "https://opencode.ai/v2/cli.json",
  "plugins": [
    {
      "package": "@max10240/opencode-plugin-unicorn",
      "options": {
        "features": { "retry": true },
        "retry": {
          "keybind": "f5",
          "continueText": "Continue"
        }
      }
    }
  ]
}
```

| 参数 | 默认值 | 说明 |
| --- | --- | --- |
| `keybind` | `f5` | Retry 快捷键；设为 `false` 后只保留 `/retry` |
| `continueText` | `Continue` | 空闲或打断完成后发送的消息 |

Unicorn 中用 `features.retry: false` 可完全关闭该插件。

## 为什么用 F5

Windows 的标准刷新键是 `F5`（资源管理器、浏览器都是）。`F4` 是地址栏，`Alt+F4` 是关闭窗口。
OpenCode TUI 默认没有使用 `F5`。

快捷键只在普通会话视图生效，不会在权限确认、问题选择等 modal 对话框里触发。macOS 笔记本如果功能键需要
`Fn`，使用 `Fn+F5`，或把 `keybind` 改成其他组合。

## 行为细节

- 先调用 `session.interrupt`，再用 `experimental.session.wait` 等待旧回合真正结束，避免 `Continue` 被送进
  正在停止的旧回合。
- `interrupt` 返回 `interrupted: false` 时会再次检查会话：真正 idle 才直接发送；如果旧回合仍在停止，则等待清理完成后再发送。
- Retry 流程进行中时，重复按键会被忽略。
- 不覆盖输入框里的草稿。
- 不清空已有队列；`Continue` 以 steer 方式发送。
- 打断失败、等待超时、发送失败、session 消失等错误都会在右上角提示，并且不发送 `Continue`。
- 功能关闭或配置无效时，不注册快捷键和 slash Command。
