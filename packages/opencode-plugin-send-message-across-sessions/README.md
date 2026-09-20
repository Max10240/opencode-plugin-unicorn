# @max10240/opencode-plugin-send-message-across-sessions

在不同 cwd 的 OpenCode session 之间发送用户风格的消息。

## Tools

- `list_online_sessions`：列出插件已观察到的在线 session，包含 session ID、标题、cwd 和状态；
- `send_message_across_sessions`：向目标 session 发送消息。消息会以以下固定格式注入目标 session：
  ```text
  来自<from_session_id>的消息: <message>
  ```

如果未提供 `target_session_id`，发送工具会返回可选 session 列表，模型应先让用户选择，再重新调用发送工具。

## Standalone configuration

```jsonc
{
  "plugins": [
    "@max10240/opencode-plugin-send-message-across-sessions",
  ],
}
```

该插件默认开启。session 列表由 OpenCode server 的 session 事件维护，因此目标 session 需要在插件开始观察后启动，
并且插件需要在同一个 OpenCode server 中运行。

## E2E

```bash
bun test
```

测试使用已安装的 `opencode`、临时 `OPENCODE_CONFIG_DIR`、本地 OpenAI-compatible proxy 和 tmux，覆盖 standalone
插件及 Unicorn 集成两种加载方式，并验证不同 cwd 的 session 收到真实的 user 消息。可用 `OPENCODE_BIN` 指定 OpenCode
可执行文件。
