# @max10240/opencode-plugin-notepad

**English** | [简体中文](README.zh-CN.md)

不打断当前 OpenCode 对话，快速记录笔记。笔记默认归属当前文件夹，也可以切换到全局，让同一 OpenCode server 上的所有 session 看到。

## 使用

独立加载时，server 和 TUI 配置都需要加入该包：

```jsonc
// opencode.jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["@max10240/opencode-plugin-notepad"]
}
```

```json
// cli.json
{
  "$schema": "https://opencode.ai/v2/cli.json",
  "plugins": ["@max10240/opencode-plugin-notepad"]
}
```

通过 Unicorn 使用时，`features.notepad` 默认开启：

```jsonc
{
  "plugins": [{
    "package": "@max10240/opencode-plugin-unicorn",
    "options": {
      "features": { "notepad": true },
      "notepad": { "keybind": "ctrl+shift+n" }
    }
  }]
}
```

## 打开方式

- 快捷键：`ctrl+shift+n`
- 命令面板：搜索 **Open notepad**
- Slash：`/notepad`

命令使用 `mode: "global"` 和 `palette: true`，因此在命令面板和 slash 补全中都能打开。

## 交互

```text
Notepad — /path/to/current/folder
/ 搜索...

This folder
  Follow up: review notepad storage
  folder · just now

Global
  Remember to check release notes
  global · 3m ago

a add · e edit · d delete · c copy · g scope · / search · tab switch · esc close
```

- `a`：新增，默认保存到当前文件夹。
- `e`：在弹窗中编辑多行内容；`f2` 或 `ctrl+enter` 保存，`esc` 取消。
- `d`：确认后删除。
- `c`：通过 OSC52 复制笔记并显示 toast。
- `g`：在当前文件夹和全局之间切换。
- `/` 或 `Tab`：聚焦搜索框；`Esc` 或 `Enter` 返回列表。
- `↑` / `↓`：选择笔记。
- `Esc`：关闭记事本。

编辑器中按 `ctrl+g` 可在 **This folder** 和 **Global** 之间切换保存目标。

## 作用域与存储

- 新笔记默认 `folder` 作用域，只在完全相同的当前目录可见。
- `global` 笔记在同一 server 的所有文件夹和 session 中可见。
- 不同文件夹、不同 worktree 的 folder 笔记互相不可见。
- 笔记存储由 server 插件管理，TUI 通过 RPC 访问；连接同一插件宿主的多个 TUI client 共享同一份数据。独立安装和 Unicorn 使用不同的 server 存储命名空间，请固定使用一种宿主方式。
- 存储只包含文本、作用域、文件夹路径和时间戳，不进入模型上下文。
- 限制：每个 server 最多 5000 条，每条最多 100 KiB。

## 配置

- `enabled` 默认 `true`，设为 `false` 可关闭。
- `keybind` 默认 `ctrl+shift+n`；设为 `false` 可移除快捷键，但保留命令面板和 slash。

## 验证

```bash
bun run --cwd packages/opencode-plugin-notepad test
bun run check
```

测试覆盖文件夹/全局可见性、CRUD、校验、命令注册，以及真实隔离 TUI 中的新增、切换作用域、复制、编辑、删除、持久化、命令面板和 slash。
