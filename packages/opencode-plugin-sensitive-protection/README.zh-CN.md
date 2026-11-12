# @max10240/opencode-plugin-sensitive-protection

[English](README.md) | **简体中文**

**别让密钥和敏感数据进入模型对话。**

你的仓库里有 `.env`、私钥、客户数据导出，或者带生产 token 的配置文件。Agent 有 shell 权限，这些文件它都能读。哪怕只是一句
“看看数据库配置”，也可能把内容发给模型 provider，并留在对话记录里。

敏感信息保护让你把文件标记为私有。插件会阻止直接读取，并在内容进入模型之前把匹配片段替换成 `[REDACTED:PROTECTED]`，
无论它来自 `read`、shell 命令还是其他工具。

## 什么时候需要它

- 项目里有凭据、token、私钥或客户数据。
- 你在共享机器上使用 OpenCode，或者使用托管模型服务。
- 你想要一层安全网，防止某次不小心的 `cat .env`。
- 你想让 Agent 在仓库里工作，但不让它读到秘密。
- 你用了敏感信息加密插件，希望它的密钥自动受到保护。

## 它能给你什么

- **阻止直接读取。** 对保护文件调用 `read` 会失败，而不是返回内容。
- **其他来源也会脱敏。** 工具输出里出现的秘密，会在模型看到之前被替换。
- **覆盖最终请求。** 脱敏会应用到完整的模型请求，不只是可见的工具结果。
- **多种登记方式。** 让 Agent 调用工具、使用 server 命令，或者在 TUI 里输入路径；登记时不会把文件内容返回给 Agent。
- **跨 session 记住。** 登记表按文件路径持久化，重启后仍然有效。
- **和加密插件联动。** 解密私钥、加密输入和明文输出会自动登记。

## 快速开始

独立使用时，在 server 配置里加载。想要 TUI 的交互式登记命令，也把 TUI 入口加上：

```jsonc
// opencode.jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["@max10240/opencode-plugin-sensitive-protection"]
}
```

```jsonc
// cli.json
{
  "$schema": "https://opencode.ai/v2/cli.json",
  "plugins": ["@max10240/opencode-plugin-sensitive-protection"]
}
```

通过 Unicorn 使用时，默认开启：

```jsonc
{
  "plugins": [{
    "package": "@max10240/opencode-plugin-unicorn",
    "options": {
      "features": { "sensitiveProtection": true },
      "sensitiveProtection": {
        "blockReads": true,
        "redactContext": true,
        "redactHttp": true
      }
    }
  }]
}
```

## 使用

按你的习惯任选一种方式登记文件：

- 让 Agent 用 `register_sensitive_file` 登记路径。
- 在 server 上运行 `/protect-sensitive-file <path>`。
- 在 TUI 运行 `/protect-sensitive-file-ui` 或配置的 keymap，然后输入路径。

登记后，直接 `read` 这个文件会被阻止。如果内容出现在任何工具输出中，匹配片段会变成 `[REDACTED:PROTECTED]`。

插件会脱敏 `grep`、shell 命令、`edit` 和 `write` 的输出，但不拦截它们的输入。因此通过 shell 读取文件仍然可以执行，只是秘密
会在模型看到之前被移除。

## 配置

| 参数 | 默认值 | 作用 |
| --- | --- | --- |
| `enabled` | `true` | 打开或关闭保护 |
| `blockReads` | `true` | 阻止对保护文件的精确路径 `read` |
| `redactContext` | `true` | 从模型请求上下文中脱敏 |
| `redactHttp` | `true` | 从发往模型 provider 的请求中脱敏 |
| `maxContentBytes` | `8388608` | 加载用于匹配的最大文件大小；硬上限 `64 MiB` |

匹配范围包括整段内容、逐行文本、JSON 转义、Base64/Base64URL 和 Hex。

## 项目级逃生舱

如果某个项目需要关闭保护，创建：

```text
.opencode/sensitive-protection.json
```

```json
{ "enabled": false }
```

这只影响当前项目，不会关闭加密插件。

## 注意事项

- **这是一层很强的安全网，但不是沙箱。** 刻意绕过、特殊编码、压缩数据、拆分输出、MCP 或 subagent 内部操作都有可能躲过匹配。
  需要强隔离时，请使用操作系统沙箱或独立用户。
- **只保存路径和元数据。** 登记表位于
  `<XDG_DATA_HOME 或 ~/.local/share>/opencode/sensitive-protection/registry.json`，不保存文件内容。
- **登记是按文件路径的。** 移动或重命名保护文件后，可能需要重新登记。
- **Agent 仍然知道文件存在。** 保护隐藏的是内容，不是文件名或元数据。
