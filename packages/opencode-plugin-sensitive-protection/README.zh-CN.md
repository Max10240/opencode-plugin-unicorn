# @max10240/opencode-plugin-sensitive-protection

[English](README.md) | **简体中文**

**让 secret 不进入模型对话。**

敏感信息保护插件在本地解析已知凭据文件，只提取 secret 值，并在进入模型前替换为 `[REDACTED:PROTECTED]`。
受保护文件解析失败时，直接阻止读取。

## 配置

所有配置都在 OpenCode 的 plugin options 里，没有插件私有配置文件。

Standalone：

```jsonc
{
  "plugins": [{
    "package": "@max10240/opencode-plugin-sensitive-protection",
    "options": {
      "files": [
        "!~/.npmrc",
        {
          "path": "~/.config/newcli/credentials.json",
          "format": "json",
          "keys": ["access_token", "servers[].password"]
        }
      ]
    }
  }]
}
```

Unicorn：

```jsonc
{
  "plugins": [{
    "package": "@max10240/opencode-plugin-unicorn",
    "options": {
      "features": { "sensitiveProtection": true },
      "sensitiveProtection": {
        "files": [
          "!~/.npmrc",
          {
            "path": "~/.config/newcli/credentials.json",
            "format": "json",
            "keys": ["access_token", "servers[].password"]
          }
        ]
      }
    }
  }]
}
```

### `files`

最终保护列表：

```text
默认条目 + config files + manual entries - 排除项
```

- 默认条目自动加入：AI CLI 凭据、云凭据、Git/SSH、包管理器 token、Terraform/Docker、netrc、Vault；
- 以 `!` 开头的字符串删除任意来源的路径：`"!~/.npmrc"`；
- 对象新增或覆盖文件：`{ "path": "...", "format": "json", "keys": ["token"] }`；
- 同一路径优先级：config > manual > default；
- 不再有 `customFiles`、`builtins`、逐文件读写策略、自定义 extractor 配置。

## 支持的格式

| 格式 | 解析 | 用途 |
| --- | --- | --- |
| `json` | 原生 | JSON 凭据和配置 |
| `yaml` | `yaml` | kubeconfig、GitHub hosts、YAML 配置 |
| `ini` | `ini` | npmrc、AWS、`.env`、INI |
| `toml` | `smol-toml` | Cargo 和 TOML 配置 |
| `private-key` | 内置 | PEM / OpenSSH 私钥 |
| `line` | 内置 | 单行 secret 文件 |
| `netrc` | 内置 | netrc 凭据 |
| `git-credentials` | 内置 | Git 凭据 |

所有结构化格式先解析成 JS 对象，再共用一套 selector 匹配，不为每种格式单独安装 matcher。

## Key selector

用 `.` 表示嵌套，用 `[]` 表示数组每个元素：

```text
auth.token
servers[].password
```

其他写法：

```text
servers[*].password     等价于 servers[].password
servers[0].password     指定数组下标
tokens[]                字符串数组的每个元素
credentials.*.token     任意子 key
*_authToken             key 名 glob（默认条目内部使用）
```

每个 selector 必须匹配至少一个非空字符串。任意一个没匹配到，整个登记失败，并列出所有缺失 selector 和可用 key。

登记 tool 传 `inspect: true` 可以只列出可用 key 路径，不读取值。

## Tool

`register_sensitive_file` 在本地登记文件，不返回文件内容。

- 结构化文件：传 `format` 和非空 `keys` 数组；
- 私钥：传 `format: "private-key"`；
- 单行 secret：不传 `format` 和 `keys`；
- 其他多行文件：拒绝。请拆成一个 secret 一个文件，或改成结构化格式并用 keys；
- `inspect: true`：只返回 key 路径。

`request_sensitive_unprotect` 只创建待批准的取消保护请求，不直接取消。用户必须在 TUI 里批准。

## 统一策略

所有受保护文件使用同一套策略：

| 操作 | 行为 |
| --- | --- |
| `read` | 允许，secret 脱敏 |
| `write` | 允许 |
| `edit` | 允许 |
| 写入 `[REDACTED:PROTECTED]` | 阻止 |
| 解析失败 | 阻止 `read`；write/edit 仍允许 |
| shell 输出 | 脱敏 |
| 模型上下文 / provider 请求 | 脱敏 |

## 默认保护文件

| 分组 | 文件 |
| --- | --- |
| AI | OpenCode、Codex、Claude、Gemini 凭据 |
| 云 | AWS、Google ADC、kubeconfig |
| 源码 | GitHub CLI、Git credentials、SSH 私钥 |
| 包管理 | npm、PyPI、Cargo |
| 基础设施 | Terraform、Docker |
| 明文 token | netrc、Vault token |

`.env` 默认不保护；需要时用 `format: "ini"` 和对应 keys 添加。

## 取消保护

用户可以在 Protected files 弹窗里直接取消任意文件：

- manual：从 registry 删除；
- default/config：写入 `!path` disabled override 到运行状态；
- Disabled 过滤器可以恢复。

模型发起的取消请求会弹 toast，并在底部显示常驻角标，直到用户批准或拒绝。没有 pending 请求时角标不常驻。

## 同步范围

同一个 OpenCode Server 内的所有项目和 session 共享保护列表。Protected files 弹窗显示整个 Server，并在每行标注所属项目。
取消保护请求也在同一 Server 内共享。不跨 Server，不做快照和心跳。

## 运行状态

manual 条目、disabled override、pending 请求存放在：

```text
$XDG_DATA_HOME/opencode/sensitive-protection/registry.json
```

或 `~/.local/share/opencode/sensitive-protection/registry.json`。只存路径和元数据，不存 secret 值。

## 注意

- 这是安全网，不是沙箱。特殊编码、压缩、拆分输出、MCP/subagent 内部操作仍可能绕过。
- 受保护文件的文件名和元数据仍然可见，隐藏的是内容。
- 文件必须存在、是普通文件、不超过 `maxContentBytes`。
- 移动或重命名文件后可能需要重新登记。
- manual 保护在 Server 内所有项目生效；default/config 跟随配置作用域。
- OpenCode V2 的 SQLite 凭据和系统 Keychain 不在覆盖范围内。
