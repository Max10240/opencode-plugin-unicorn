# @max10240/opencode-plugin-prompt-search

[English](README.md) | **简体中文**

**别再重写已经写过的 prompt。**

用上几周，OpenCode 里就会积累几百条 prompt：一份 review 清单、一段调试说明、一份迁移计划，或者一条你花了十分钟才措辞好的
指令。等你需要再用时，它多半埋在某个只记得大概的 session 里。

Prompt 检索给 TUI 加了一个跨 session 的反向搜索。找回旧 prompt，按 Enter 插入输入框，改一改就能用。

## 什么时候需要它

- 你在不同项目间复用同一套 review、测试、重构或发布 prompt。
- 你记得 prompt 的内容，但想不起它来自哪个 session。
- 你想要一个自己的 prompt 库，又不想再开一个笔记工具。
- 你刚接手项目，想复用以前的自己或同事写过的 prompt。

## 它能给你什么

- **跨 session 搜索。** 只索引顶层 session 的 prompt，subagent session 会被跳过。
- **排队中的消息也能搜。** 还在 session inbox 里等待投递的消息同样会被索引。
- **只插入，不发送。** 选中结果后只是放到光标位置，发不发、改不改由你决定。
- **重启后仍然可用。** 索引保存在本地 TUI 存储里，重开 TUI 还能搜。
- **已删除的 session 也能找回。** 只要 prompt 在 session 消失前已经进入索引，就仍然可搜索。
- **私密。** 索引只在本机，不会发给模型，也不会修改你的对话。

## 快速开始

在 TUI 配置中加载：

```jsonc
{
  "$schema": "https://opencode.ai/v2/cli.json",
  "plugins": [{
    "package": "@max10240/opencode-plugin-prompt-search",
    "options": { "keybind": "ctrl+shift+r" }
  }]
}
```

使用 Unicorn 时：

```jsonc
{
  "plugins": [{
    "package": "@max10240/opencode-plugin-unicorn",
    "options": {
      "features": { "promptSearch": true },
      "promptSearch": { "keybind": "ctrl+shift+r", "maxPrompts": 2000 }
    }
  }]
}
```

## 使用

按 `ctrl+shift+r`，或在命令面板搜索 **Search previous prompts**。

1. 输入你还记得的几个词。匹配结果按时间从新到旧排列。
2. 用 `↑` / `↓` 浏览结果。
3. 按 `Tab` 在“全部项目”和“当前项目”之间切换。
4. 按 `Enter` 把原 prompt 插入光标位置。
5. 需要的话改一改，再发送。

默认快捷键避开了 OpenCode 的内置绑定，也可以换成你习惯的组合。

## 配置

| 参数 | 默认值 | 作用 |
| --- | --- | --- |
| `keybind` | `ctrl+shift+r` | 打开 Prompt 检索的快捷键 |
| `maxPrompts` | `2000` | 本地索引最多保留多少条最近的 prompt |

`maxPrompts` 是存储预算，不是搜索上限。索引超出预算时，最旧的 prompt 会先被淘汰。设为 `0` 会清空缓存并停止保留 prompt。
调高上限会重新索引 server 上仍然存在的 session，但已删除且已被淘汰的 prompt 无法恢复。

## 注意事项

- **最新的匹配排在最前。** 查询只负责过滤，不会按相关度重排；按 `Tab` 可只搜索当前项目。
- **不记录 subagent 的 prompt。** 子 session 会被跳过，缓存中的子 session prompt 会在刷新时移除。
- **搜索在本地完成。** 索引会随 session 变化增量刷新，输入时不会扫描整个 server。
- **历史必须曾经保存。** 如果 session 在插件第一次索引它之前就被删除，OpenCode 已经无法导出它，这部分 prompt 找不回来。
- **删除 session 不会立即清理缓存。** 对应 prompt 会保留到存储预算把它们淘汰。
- **选中只会插入，不会发送。** 最终发什么，由你决定。
- **索引独立于 session 数据库。** 它属于 TUI 存储，卸载插件不会删除你的对话。
