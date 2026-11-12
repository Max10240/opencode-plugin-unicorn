# @max10240/opencode-plugin-notepad

[English](README.md) | **简体中文**

**一个不会打断对话的随手记。**

你正在做事，突然想到一个后续、一个要检查的 bug、一条稍后要跑的命令。直接打进对话框，会和 Agent 当前的任务抢注意力；
切到别的应用，思路又断了；随手丢进临时文件，最后多半会忘在仓库角落。

记事本给这类念头一个随时可开的小窗口。它覆盖在 TUI 上方，保存时不打扰当前 session，并按文件夹或全局把笔记整理好。

## 什么时候需要它

- Agent 正在忙，你突然想到一个后续事项，想先记下来。
- 你想给每个项目维护自己的提醒，不希望它们出现在别的项目里。
- 你有一份个人清单，希望在每个 session 里都能看到。
- 你想把某条笔记复制回输入框，不想重新打字。
- 你不希望笔记变成模型对话的一部分。

## 它能给你什么

- **完全不打断。** 打开、写、关闭，Agent 不会察觉。
- **默认按文件夹归档。** 笔记跟着项目走。
- **需要时再全局共享。** 按 `g` 可以把笔记放到所有文件夹和 session 都能看到的位置。
- **完整的编辑能力。** 新增、编辑、删除、搜索、复制、切换作用域，都不用离开弹窗。
- **默认私密。** 笔记是写给你自己看的，不会进入模型上下文。

## 快速开始

独立使用时，server 和 TUI 配置都要加载：

```jsonc
// opencode.jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["@max10240/opencode-plugin-notepad"]
}
```

```jsonc
// cli.json
{
  "$schema": "https://opencode.ai/v2/cli.json",
  "plugins": ["@max10240/opencode-plugin-notepad"]
}
```

通过 Unicorn 使用时，记事本默认开启：

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

- 按 `ctrl+shift+n`。
- 在命令面板搜索 **Open notepad**。
- 输入 `/notepad`。

## 使用

```text
Notepad — /path/to/current/folder
/ Search...

This folder
  Follow up: review notepad storage
  folder · just now

Global
  Remember to check release notes
  global · 3m ago

a add · e edit · d delete · c copy · g scope · tab search · esc close
```

| 按键 | 操作 |
| --- | --- |
| `a` | 新增笔记，默认保存到当前文件夹 |
| `e` | 编辑选中的笔记；`f2` 保存，`esc` 取消 |
| `d` | 确认后删除 |
| `c` | 复制笔记内容并显示提示 |
| `g` | 在当前文件夹和 Global 之间切换 |
| `Tab` | 聚焦搜索框；`Enter` 或 `Esc` 回到列表 |
| `↑` / `↓` | 选择笔记 |
| `Esc` | 关闭记事本 |

编辑器中按 `ctrl+g` 可以在 **This folder** 和 **Global** 之间切换保存目标。

## 笔记怎么归档

- **This folder** 的笔记只在创建时的那个目录可见。不同文件夹、不同 worktree 互不可见。
- **Global** 的笔记在同一 OpenCode server 的所有文件夹和 session 中可见。
- 连接同一 server 的所有 TUI client 共享同一份笔记，换一台机器连上去也能看到。
- 笔记以纯文本保存，包含作用域、文件夹路径和时间戳，不会进入模型上下文。
- 上限够用但有限：每个 server 最多 5000 条，每条最多 100 KiB。

独立加载和通过 Unicorn 加载使用的是两套笔记存储。选一种方式用就好，不要来回切换。

## 配置

| 参数 | 默认值 | 作用 |
| --- | --- | --- |
| `enabled` | `true` | 设为 `false` 关闭记事本 |
| `keybind` | `ctrl+shift+n` | 修改快捷键；设为 `false` 后仍可通过命令面板和 `/notepad` 打开 |
