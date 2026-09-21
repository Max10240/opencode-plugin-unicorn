# @max10240/opencode-plugin-prompt-search

为 OpenCode TUI 提供跨 session 的 prompt reverse-search。

## 使用

TUI plugin 使用 V2 的 `cli.json` 配置：

```jsonc
{
  "plugins": [
    {
      "package": "@max10240/opencode-plugin-prompt-search",
      "options": {
        "keybind": "ctrl+shift+r",
      },
    },
  ],
}
```

默认快捷键是 `ctrl+shift+r`，避开当前 OpenCode 默认快捷键。也可以把插件放入 Unicorn 的 TUI 入口，使用：

```jsonc
{
  "plugins": [
    {
      "package": "@max10240/opencode-plugin-unicorn",
      "options": {
        "features": {
          "promptSearch": true,
        },
      },
    },
  ],
}
```

搜索结果来自 OpenCode server 中所有可见 session 的 user prompts，索引按 session 更新时间增量刷新，并通过 TUI
storage 缓存。选择结果后会把原 prompt 作为当前 session 的新 user message 排队发送。

`cli.json` 中的 plugin options 和 `keybind` 都可以按机器覆盖：

```jsonc
{
  "plugins": [
    {
      "package": "@max10240/opencode-plugin-prompt-search",
      "options": { "keybind": "alt+shift+r" },
    },
  ],
}
```

## 测试

```bash
bun test
```

测试使用临时 OpenCode server 和 mock provider；不会调用真实模型。
