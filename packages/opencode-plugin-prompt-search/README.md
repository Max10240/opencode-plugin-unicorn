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
storage 缓存。已缓存的 prompt 会在对应 session 从 server 列表中消失后继续保留，因此删除 session 后仍可检索，TUI
重启后也可用。若 session 在插件索引它之前就已删除，OpenCode API 已无法导出其对话，插件无法补建索引。选择结果后会
把原 prompt 插入当前输入框的光标位置，不会自动提交。

缓存默认最多保留最近的 2000 条 user prompt，可在插件 options 中通过 `maxPrompts` 修改。删除源 session 不会立即清理
缓存，也没有按时间过期策略；插件启动时发现缓存超限，或索引刷新后超限，都会按 prompt 时间从旧到新淘汰。设置为 `0`
会清空已缓存 prompt 并停止保留 prompt。
提高上限时，仍存在于 server 中且曾被限额截断的 session 会在刷新时重新索引；已删除且已淘汰的 prompt 无法恢复。

TUI storage 由 OpenCode 管理，默认位于 `~/.local/state/opencode/<channel>/tui/`，不是 session 数据库。独立加载时，索引文件为
`plugin.max10240.prompt-search.tui.prompt-search.index.json`；通过 Unicorn 加载时，文件为
`plugin.max10240.unicorn.tui.prompt-search.index.json`。设置 `XDG_STATE_HOME` 时，根目录相应变为
`$XDG_STATE_HOME/opencode`。插件通过 `context.storage.store` 读写此文件。

```jsonc
{
  "plugins": [
    {
      "package": "@max10240/opencode-plugin-prompt-search",
      "options": { "maxPrompts": 5000 },
    },
  ],
}
```

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
