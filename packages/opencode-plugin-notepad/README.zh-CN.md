# @max10240/opencode-plugin-notepad

[English](README.md) | **简体中文**

**一个不会打断对话的随手记。**

你正在做事，突然想到一个后续、一个要检查的 bug、一条稍后要跑的命令。直接打进对话框，会和 Agent 当前的任务抢注意力；
切到别的应用，思路又断了；随手丢进临时文件，最后多半会忘在仓库角落。

记事本给这类念头一个随时可开的小窗口。它覆盖在 TUI 上方，保存时不打扰当前 session，并按 session、文件夹或全局把笔记整理好。

## 什么时候需要它

- Agent 正在忙，你突然想到一个后续事项，想先记下来。
- 你希望某条笔记只留在当前 session。
- 你想给每个项目维护自己的提醒，不希望它们出现在别的项目里。
- 你有一份个人清单，希望在每个 session 里都能看到。
- 你想把某条笔记复制回输入框，不想重新打字。
- 你不希望笔记变成模型对话的一部分，除非明确把某一条设为 session 目标。

## 它能给你什么

- **完全不打断。** 打开、写、关闭，Agent 不会察觉。
- **默认按 session 归档。** 笔记留在写下它的那个 session。
- **用 `Ctrl+A` 选择作用域。** Current Session、Current Directory、Global 同时决定列表显示什么、新笔记保存到哪里。
- **快捷创建。** 在创建框里输入后按 `Enter` 直接保存，没有单独的创建面板。
- **完整的编辑能力。** 新增、编辑、删除、搜索、复制、固定，都不用离开弹窗。
- **Session 目标。** 按 `Ctrl+T` 可以把 Current Session 或 Current Directory 中的笔记设为当前 session 的目标。目标会作为 session 上下文注入，变化时会明确标注旧目标已被替换。
- **可恢复删除。** `Ctrl+Z` 恢复最近删除的一条笔记；目标笔记在清除目标前受保护。
- **默认私密。** 除非你明确把某条笔记设为 session 目标，否则笔记不会进入模型上下文。

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
Notepad Current Session                                      f1 help · esc close
ctrl+a Show notes in Current Directory
/path/to/current/folder

Search in Current Session
New note in Current Session

🎯 Follow up: review notepad storage
  goal · session · just now
📌 Remember to check release notes
  pinned · session · 3m ago

ctrl+e edit · ctrl+d delete · ctrl+p pin · ctrl+t goal · ctrl+s sort: updated · ctrl+y copy · ↑/↓ select · tab search/create · f1 help
```

| 按键 | 操作 |
| --- | --- |
| `Enter`（创建框） | 按当前作用域创建笔记 |
| `Shift+Enter`（创建框） | 在正在写的笔记里换行 |
| `Ctrl+A` | 切换作用域：Current Session → Current Directory → Global |
| `Ctrl+T` | 把选中的笔记设为当前 session 的目标；已是目标时清除目标 |
| `Ctrl+E` | 编辑选中的笔记；`f2` 或 `ctrl+s` 保存，`esc` 取消 |
| `Ctrl+D` | 删除选中的笔记；连按两次确认。目标笔记受保护 |
| `Ctrl+Z` | 恢复最近删除的一条笔记 |
| `Ctrl+P` | 固定/取消固定选中的笔记；固定笔记排在未固定笔记之前 |
| `Ctrl+S` | 在“最近更新”和“创建时间”之间切换排序 |
| `Ctrl+Y` | 复制笔记内容并显示提示 |
| `Tab` | 在搜索框和创建框之间切换焦点 |
| `↑` / `↓` | 选择笔记；默认选中列表第一项 |
| `F1` | 显示或关闭快捷键帮助 |
| `Esc` | 关闭帮助或关闭记事本 |

搜索框和创建框的占位文字始终显示当前作用域。切换作用域时，两个输入框里已经写好的内容不会丢失。header 会同时显示当前作用域和 `Ctrl+A` 将切换到的下一个作用域，并高亮下一个作用域；当前聚焦输入框的下边线也会高亮。

笔记创建后不能修改作用域。

## Session 目标

- 在 **Current Session** 或 **Current Directory** 笔记上按 `Ctrl+T`，把它设为当前 session 的目标。Global 下该快捷键禁用，footer 提示显示为灰色。
- 一个 session 最多只有一个目标。设置另一条笔记会替换旧目标；再按 `Ctrl+T` 清除目标，笔记回到正常排序位置。
- 目标保存在 `notepad.goal` 这个 session instruction entry 中。该 session 的每次模型请求都会看到它，它是系统级上下文，不会伪装成用户输入。
- 目标变化时，OpenCode 会追加一条系统消息，说明旧值已被替换；清除时会说明该上下文不再适用。目标不会重复拼进每条用户消息。
- 目标笔记用 `🎯` 标记，固定笔记用 `📌`，目标永远排第一。即使搜索词不匹配或当前作用域不包含它，目标仍会显示。
- 设置超过 8 KiB 的笔记为目标会被拒绝。编辑目标笔记会同步更新目标文本；编辑后超过 8 KiB 时，目标会被自动清除并提示。
- 目标笔记在清除目标前不能删除。
- 只有目标文本会进入模型上下文，其他笔记仍然私密。

## 笔记怎么归档

- **Current Session** 的笔记只在写下它的 session 中可见，即使别的 session 使用同一个文件夹也看不到。
- **Current Directory** 的笔记在同一个文件夹的所有 session 中可见。不同文件夹、不同 worktree 互不可见。
- **Global** 的笔记在同一 OpenCode server 的所有文件夹和 session 中可见。
- 连接同一 server 的所有 TUI client 共享同一份笔记，换一台机器连上去也能看到。
- 笔记以纯文本保存，包含作用域、session id 或文件夹路径以及时间戳。除非设为 session 目标，否则不会进入模型上下文。
- 上限够用但有限：每个 server 最多 5000 条，每条最多 100 KiB，每个目标最多 8 KiB。

独立加载和通过 Unicorn 加载使用的是两套笔记存储。选一种方式用就好，不要来回切换。

## 配置

| 参数 | 默认值 | 作用 |
| --- | --- | --- |
| `enabled` | `true` | 设为 `false` 关闭记事本 |
| `keybind` | `ctrl+shift+n` | 修改快捷键；设为 `false` 后仍可通过命令面板和 `/notepad` 打开 |
| `defaultSort` | `updated` | 初始排序：`updated` 或 `created`；上次选择会被记住 |
