# @max10240/opencode-plugin-unicorn

[English](README.md) | **简体中文**

**一次安装，得到整套 OpenCode 增强工具。**

Unicorn 把本仓库的插件打包成一个包：一套统一的配置方式、每个功能独立开关。适合想明显改善 OpenCode 使用体验，但不想逐个安装、
逐个升级、逐个配置插件的人。

## 适合谁

- 你想用下面不止一个插件，更愿意一次装好。
- 你在多台机器上使用 OpenCode，希望版本和行为保持一致。
- 你喜欢“整套工具”的思路，但又想单独关掉某些功能。
- 你正在配置新机器，不想手动拼装这一套插件。

## 为什么用 Unicorn

- **只装一个包。** 所有功能一起升级，版本不会互相错位。
- **只学一套配置。** Server 端和 TUI 端使用同一套选项名和同名嵌套对象。
- **可以独立关闭。** 关掉一个功能不会影响其他功能。
- **随时可以拆开用。** 每个子插件都能独立安装；Unicorn 只是省事，不会把你锁死。
- **本地和远程都适用。** Server 功能跑在 server 上，TUI 功能跑在 TUI 所在的一端。

## 快速开始

把 Unicorn 加到功能所属的配置里：

```jsonc
// opencode.jsonc — server：图片生成、图片预览、跨 session 消息、笔记、安全
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["@max10240/opencode-plugin-unicorn"]
}
```

```jsonc
// cli.json — TUI：检索、记事本、自动后台、预览
{
  "$schema": "https://opencode.ai/v2/cli.json",
  "plugins": ["@max10240/opencode-plugin-unicorn"]
}
```

TUI 连接远程 server 时，两端都要安装 Unicorn：server 配置控制 server 功能，client 的 `cli.json` 控制 TUI 功能。
只在 server 运行的插件不会在 client 里执行。

除了推荐配置插件，其他功能默认全部开启。想改默认值时，使用与功能同名的嵌套对象：

```jsonc
{
  "plugins": [{
    "package": "@max10240/opencode-plugin-unicorn",
    "options": {
      "features": { "imageGen": false },
      "nonBlocking": { "thresholdMs": 5000 }
    }
  }]
}
```

## 功能一览

| 功能 | 开关 | 作用 |
| --- | --- | --- |
| 自动后台 | `features.nonBlocking` | 把长时间运行的 Bash 和 subagent 转入后台，让你继续工作 |
| Prompt 检索 | `features.promptSearch` | 搜索所有历史 session 的 prompt，并插入而不发送 |
| 当前对话检索 | `features.sessionSearch` | 搜索当前对话，跳转到匹配消息或复制原文 |
| 跨 session 消息 | `features.sendMessageAcrossSessions` | 让一个 session 给另一个 cwd 的 session 发消息 |
| 图片生成 | `features.imageGen` | 生成或编辑图片并保存成文件 |
| 图片预览 | `features.showImg` | 在对话里显示图片，不把图片字节加入模型上下文 |
| OpenCode Go 用量 | `features.opencodeGoUsage` | 展示所有已登录账号的 OpenCode Go 5 小时、每周和每月用量 |
| 记事本 | `features.notepad` | 按文件夹或全局保存笔记，不打断对话 |
| 敏感信息加密 | `features.sensitiveEncrypt` | 用公钥加密敏感内容，只解密到文件 |
| 敏感信息保护 | `sensitiveProtection` | `files`、`maxContentBytes`、`notifications`、`historyLimit`、`historyKeybind` |
| 推荐配置 | `features.recommendedOpencodeConfig` | 补充精选全局规则和命令，并设置 OpenAI `store:false` |

## 功能配置

Unicorn 会把每个同名嵌套对象原样传给对应插件。默认值由插件自己决定，Unicorn 不重命名字段，也不把不同插件的配置混在一起。
没有配置时传入 `{}`，所以不写任何参数也能正常使用。

| 功能 | 嵌套对象 | 常用参数 |
| --- | --- | --- |
| 自动后台 | `nonBlocking` | `thresholdMs`（默认 `10000`） |
| Prompt 检索 | `promptSearch` | `keybind`（默认 `ctrl+shift+r`）、`maxPrompts`（默认 `2000`） |
| 当前对话检索 | `sessionSearch` | `keybind`（默认 `ctrl+shift+f`） |
| 跨 session 消息 | `sendMessageAcrossSessions` | 无需配置 |
| 图片生成 | `imageGen` | `model`、`baseURL`、`integrationID` |
| 图片预览 | `showImg` | 用 `features.showImg` 开关；无需额外参数 |
| OpenCode Go 用量 | `opencodeGoUsage` | `keybind`（默认不绑定） |
| 记事本 | `notepad` | `keybind`（默认 `ctrl+shift+n`）、`enabled` |
| 敏感信息加密 | `sensitiveEncrypt` | `publicKeyFileForEncrypt`、`privateKeyFileForDecrypt`、`maxBytes` |
| 敏感信息保护 | `sensitiveProtection` | `files`、`maxContentBytes`、`notifications`、`historyLimit`、`historyKeybind` |
| 推荐配置 | `recommendedOpencodeConfig` | `enabled` |

`features.<名称>: false` 永远优先，会关闭对应功能，且不影响其他功能。子插件自己的关闭参数同样有效，例如
`showImg.features.showImg: false` 或 `notepad.enabled: false`。

OpenCode Go 用量默认开启，但只有当前 server 存在 OpenCode Console credential 时命令才会出现。输入
`/usage-opencode-go` 查看，默认不绑定快捷键。

推荐配置有一个特殊规则：`features.recommendedOpencodeConfig: false` 会强制关闭，但不设置开关并不会自动启用。
需要显式写 `"recommendedOpencodeConfig": { "enabled": true }`，或者让插件读取 server 环境里的 `IS_MAX_SELF`。

## 常用组合

**让 Agent 一直动起来。** 保留自动后台，长构建或 subagent 跑满十秒后就把控制权还给你：

```jsonc
{ "nonBlocking": { "thresholdMs": 10000 } }
```

**把隐私作为默认选项。** 保护敏感文件、加密密钥，并让 OpenAI 不保存请求：

```jsonc
{
  "features": { "sensitiveProtection": true, "sensitiveEncrypt": true },
  "recommendedOpencodeConfig": { "enabled": true }
}
```

**少用几个快捷键。** 关闭 Prompt 检索和当前对话检索，只保留记事本和自动后台：

```jsonc
{ "features": { "promptSearch": false, "sessionSearch": false } }
```

## 从扁平配置升级

Unicorn 不再读取顶层的 `model`、`baseURL`、`integrationID`、`keybind`、`shortcut`、`maxPrompts` 或
`sessionSearchKeybind`。图片参数移到 `imageGen`，Prompt 检索参数移到 `promptSearch`，`sessionSearchKeybind` 改为
`sessionSearch.keybind`。

如果以前用 `features.recommendedOpencodeConfig: true` 启用推荐配置，还需要补充
`recommendedOpencodeConfig.enabled: true`。独立插件的配置格式没有变化。

## 了解更多

每个功能都有独立 README，包含使用方式、典型场景和注意事项：

- [自动后台](../opencode-plugin-non-blocking/README.zh-CN.md)
- [Prompt 检索](../opencode-plugin-prompt-search/README.zh-CN.md)
- [当前对话检索](../opencode-plugin-session-search/README.zh-CN.md)
- [跨 session 消息](../opencode-plugin-send-message-across-sessions/README.zh-CN.md)
- [图片生成](../opencode-plugin-image-gen/README.zh-CN.md)
- [图片预览](../opencode-plugin-show-img/README.zh-CN.md)
- [OpenCode Go 用量](../opencode-plugin-opencode-go-usage/README.zh-CN.md)
- [记事本](../opencode-plugin-notepad/README.zh-CN.md)
- [敏感信息加密](../opencode-plugin-sensitive-encrypt/README.zh-CN.md)
- [敏感信息保护](../opencode-plugin-sensitive-protection/README.zh-CN.md)
- [推荐配置](../opencode-plugin-recomended-opencode-config/README.zh-CN.md)
