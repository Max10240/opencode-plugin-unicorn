# @max10240/opencode-plugin-sensitive-protection

[English](README.md) | **简体中文**

**别让密钥和敏感数据进入模型对话。**

你的机器和项目里有很多凭据：AI CLI 登录、云平台密钥、SSH 私钥、包管理器 token，以及 `.env` 文件。有 shell
权限的 Agent 都能读到它们，哪怕只是一句“看看配置”，也可能把内容发给模型 provider。

敏感信息保护认识常见的凭据文件，只提取真正敏感的字段；该阻断的直接阻断，其他场景把值替换成
`[REDACTED:PROTECTED]`，在进入模型之前完成脱敏。每次规则命中还会显示 TUI 右上角提示、可点击的详情状态和
实时保护历史，不会静默失败。

## 默认保护哪些文件

插件只读取下面列出的字段，不会把整个文件或每一行都当成脱敏模式。

| 分组 | 默认文件 | 提取字段 |
| --- | --- | --- |
| AI Agent | `~/.local/share/opencode/auth.json`、`~/.codex/auth.json`、`~/.claude/.credentials.json`、`~/.gemini/oauth_creds.json` | `key`、`token`、`access`、`refresh`、`OPENAI_API_KEY`、`access_token`、`refresh_token`、`id_token`、`accessToken`、`refreshToken`、`personal_access_token` |
| 云 | `~/.aws/credentials`、`~/.config/gcloud/application_default_credentials.json`、`~/.kube/config` | AWS key/secret/session token；GCP `client_secret`、`refresh_token`、`private_key`、`access_token`；kubeconfig 的 `token`、`password`、`client-key-data` |
| 代码托管 | `~/.config/gh/hosts.yml`、`~/.git-credentials`、`~/.ssh/id_rsa`、`id_ed25519`、`id_ecdsa`、`id_dsa` | GitHub `oauth_token`；Git URL 中的 password；SSH 私钥块 |
| 包管理器 | `~/.npmrc`、`~/.pypirc`、`~/.cargo/credentials.toml` 或 `~/.cargo/credentials` | npm `_authToken`、`_auth`、`_password`；PyPI `password`；Cargo registry `token` |
| 基础设施 | `~/.terraform.d/credentials.tfrc.json`、`~/.docker/config.json` | Terraform host `token`；Docker `auths.*.auth`、`identitytoken`、`registrytoken` |
| 明文 token | `~/.netrc`、`~/.vault-token` | netrc `password`；Vault token |

`.env` **不默认保护**。它和项目强相关，经常混合普通配置和 secret；需要时通过 `customFiles` 显式加入。Copilot/Cursor
的 fallback 文件、Azure token 缓存、Terraform `.terraformrc` HCL、浏览器数据库和 shell history 也不在第一批范围内。

启用敏感信息加密插件时，它的解密私钥、加密输入和解密输出会自动登记。

## 读和写的策略

- **内置和自定义的结构化文件允许读取，但值会脱敏。** Agent 可以查看 npmrc、auth JSON、kubeconfig 或 `.env` 的结构，
  但 secret 值显示为 `[REDACTED:PROTECTED]`，不影响正常的配置工作。
- **内置和自定义文件禁止整文件写入。** Agent 不能用新内容覆盖受保护文件，避免把里面的 secret 冲掉。
- **私钥和 Vault token 完全阻断。** 读取或修改 SSH 私钥、Vault token 都会被拒绝。
- **Shell 输出会脱敏。** `cat`、`grep` 等命令仍可执行，但提取出的 secret 值会在模型看到之前被替换。

## TUI 提示

命中时会在 TUI 右上角弹出 toast：

```text
Sensitive protection
Blocked read to id_ed25519

Sensitive protection
Redacted 2 sensitive values from shell output

Sensitive protection warning
Could not extract sensitive values from .npmrc; reads are blocked
```

一次工具调用命中多个值时只弹一次，并显示数量。Toast 不会包含 secret 原文。

这里的数量是“本次发往模型的请求中的出现次数”，不是累计值。模型上下文会在每次请求前重新构建，所以仍然存在的值
每一轮都可能被再次脱敏。插件会合并这种重复条件，不会每条消息都重复弹窗；出现新的文件、新的 key，或数量增加时
仍会提示。

Toast 由宿主渲染，插件 API 没有提供点击回调。为了让详情只差一步：

- 提示出现后，输入框底部会显示可点击的 `access blocked · details` 或 `N values redacted · details` 状态，持续 30 秒。
- `ctrl+shift+h` 可以直接打开历史弹窗；用 `historyKeybind` 修改，设为 `false` 关闭快捷键。
- 即使关闭通知，也可以用 `/protection-history` 或命令面板打开。命令默认显示全部会话；底部状态默认显示触发它的会话。

如果触发来自其他会话，toast 还会显示 `Open`，点击可直接跳到那个会话；底部状态仍然打开完整的历史弹窗。

提示需要 TUI 入口。通过 Unicorn 使用时两端会自动加载；独立使用时需要在 `opencode.jsonc` 和 `cli.json`
都加载这个包。

## 保护历史

历史弹窗会展示每次触发需要的上下文：

- 是阻断访问还是脱敏，以及发生在哪个阶段（模型上下文、provider 请求、工具输出、文件读取）；
- 命中的受保护文件，以及提取出的 key，例如 `~/.npmrc` 中的 `_authToken`；
- 触发它的会话标题、短 Session ID 和项目目录；
- 首次/最近触发时间，以及重复次数。

弹窗打开期间会实时更新。按 `t` 打开过滤菜单，按 `0` 重置过滤，`s` 在本会话/全部会话之间切换，`c`
复制当前报告，`enter` 打开触发会话，连续按两次 `x` 清空历史。会话已被删除时会显示为不可用，而不是让弹窗失败。

按 `f` 切换到 Protected files。该视图列出当前保护 registry 中的文件、来源、读写策略、提取出的 key 标签和
最近命中时间。按 `enter` 返回 History 并只看该文件，按 `backspace` 清除文件过滤，按 `c` 复制路径和 key
标签；不会显示 secret 原文。registry 变化时列表会自动刷新，也可以按 `r` 手动刷新。

历史只包含元数据，不包含 secret 原文；保存在 server 内存中，server 退出即消失。客户端最多保留 1,000 条，
每次最多渲染 100 行。重复条件会合并，避免每轮请求都把列表撑大。

## 快速开始

独立使用：

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

通过 Unicorn 使用时默认开启：

```jsonc
{
  "plugins": [{
    "package": "@max10240/opencode-plugin-unicorn",
    "options": {
      "features": { "sensitiveProtection": true },
      "sensitiveProtection": {
        "builtins": true,
        "notifications": true
      }
    }
  }]
}
```

## 自定义文件

使用 `customFiles` 保护内置列表之外的文件。格式是 JSON、YAML、INI 或 TOML 时，优先用声明式配置：

```jsonc
{
  "sensitiveProtection": {
    "customFiles": [
      {
        "path": "~/work/secrets.json",
        "format": "json",
        "fields": ["apiKey", "token"]
      },
      {
        "path": "~/.npmrc",
        "format": "ini",
        "fields": ["_authToken", "_auth", "_password"]
      }
    ]
  }
}
```

每个自定义文件还支持 `read`（`redact` 或 `block`）和 `write`（`block` 或 `allow`）。特殊格式可以用 extractor
返回需要保护的值，它在本地 server 进程中执行：

```jsonc
{
  "sensitiveProtection": {
    "allowCustomExtractors": true,
    "customFiles": [{
      "path": "~/.npmrc",
      "extractor": "const data = context.parseIni(); return Object.entries(data).filter(([key]) => key.endsWith('_authToken') || key.endsWith('_auth') || key.endsWith('_password')).map(([, value]) => value)"
    }]
  }
}
```

`context` 提供：

| 字段 | 含义 |
| --- | --- |
| `file` | 当前配置文件的绝对路径 |
| `home` | 当前 home 目录 |
| `readFile(path?)` | 读取 UTF-8 文本；不传参数时读取 `file`，受大小限制 |
| `parseJson(text?)` | 解析 JSON；不传文本时读取文件 |
| `parseYaml(text?)` | 解析 YAML |
| `parseIni(text?)` | 解析 INI/key-value |
| `parseToml(text?)` | 解析 TOML |

extractor 必须返回 `string[]`，并且只包含 secret 值。它是任意本地代码，不是沙箱；只应在可信的用户配置里启用，
不要把 extractor 代码提交到不可信的仓库。

## 配置

| 参数 | 默认值 | 作用 |
| --- | --- | --- |
| `enabled` | `true` | 打开或关闭保护 |
| `builtins` | `true` | 加载内置凭据文件列表 |
| `disabledBuiltinGroups` | `[]` | 关闭分组：`aiAgents`、`cloud`、`sourceControl`、`packageRegistries`、`infrastructure`、`plaintextTokens`、`sshKeys` |
| `blockReads` | `true` | 阻止 read 策略为 `block` 的条目 |
| `redactContext` | `true` | 从模型请求上下文脱敏 |
| `redactHttp` | `true` | 从发往模型 provider 的请求脱敏 |
| `maxContentBytes` | `8388608` | 提取时读取的最大文件大小；硬上限 `64 MiB` |
| `customFiles` | `[]` | 额外文件和提取规则 |
| `allowCustomExtractors` | `false` | 允许 `customFiles` 中的 JavaScript `extractor` 字符串 |
| `notifications` | `true` | 命中或解析失败时显示 TUI toast 和底部详情状态 |
| `historyLimit` | `200` | 历史最多保留的条件数，`0`–`1000`；`0` 只显示当前 TUI 收到的实时事件 |
| `historyKeybind` | `"ctrl+shift+h"` | 打开保护历史的快捷键；设为 `false` 关闭绑定 |

内置文件每两秒检查一次 `mtime`、大小和 inode，只有变化时才重新提取。插件不主动刷新 token，只在所属 CLI
更新文件后重新读取。

## 手动登记

仍然可以显式登记任意文件：

- 让 Agent 调用 `register_sensitive_file`。
- 在 server 上运行 `/protect-sensitive-file <path>`。
- 在 TUI 运行 `/protect-sensitive-file-ui` 或配置的 keymap。

手动登记的文件使用整文件匹配，并持久化到
`<XDG_DATA_HOME 或 ~/.local/share>/opencode/sensitive-protection/registry.json`；内置和自定义文件定义不会写入这里。

## 项目级逃生舱

某个项目需要关闭保护时，创建：

```text
.opencode/sensitive-protection.json
```

```json
{ "enabled": false }
```

这只影响当前项目，不会关闭加密插件。

## 注意事项

- **这是安全网，不是沙箱。** 刻意绕过、特殊编码、压缩数据、拆分输出、MCP 或 subagent 内部操作都有可能躲过匹配。
  需要强隔离时，请使用操作系统沙箱或独立用户。
- **内置/自定义条目只保留提取出的值。** 手动登记使用整文件模式；磁盘上的登记表只存路径和元数据，不保存文件内容。
- **移动或重命名文件后可能需要重新登记。**
- **部分 AI Agent 把凭据放在系统 Keychain。** 只能保护它们的明文 fallback 文件。
- **OpenCode V2 把凭据放在 SQLite。** `opencode.db` 是二进制数据库，本版本不读取；只覆盖旧版 `auth.json` 和内置列表中的文本文件。
- **Agent 仍然知道文件存在。** 保护隐藏的是内容，不是文件名或元数据。
- **保护历史只在本机内存中，且只有元数据。** 记录文件路径、key 名称、Session ID、标题和目录，不记录 secret
  原文，也不写入磁盘。可在弹窗中连续按两次 `x` 清空。
