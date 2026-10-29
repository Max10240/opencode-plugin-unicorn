# @max10240/opencode-plugin-sensitive-protection

[English](README.md) | **简体中文**

登记保护文件，在文件读取或工具输出进入模型上下文前阻断或脱敏。可独立使用，不依赖加解密插件。

## 能力

- `register_sensitive_file`：登记文件，读取内容到内存用于匹配，不输出文件内容；
- `/protect-sensitive-file <path>`：server 命令登记；
- `/protect-sensitive-file-ui` / keymap：TUI 弹出路径输入并登记；
- `read` 精确路径命中保护文件时抛出 `Tool.Error`；
- 所有 tool 输出命中保护内容时，将敏感片段替换为 `[REDACTED:PROTECTED]`；
- 模型请求上下文和 HTTP 请求体做最终脱敏；
- 按 `kid`/路径持久化登记表；
- 加密插件存在时，自动登记其解密私钥。

不拦截 `grep`、`shell`、`edit`、`write` 的输入；它们在输出阶段脱敏。

## 配置

```jsonc
{
  "sensitiveProtection": {
    "enabled": true,
    "blockReads": true,
    "redactContext": true,
    "redactHttp": true,
    "maxContentBytes": 8388608
  }
}
```

- `enabled` 默认 `true`；
- `blockReads` 默认 `true`；
- `maxContentBytes` 默认 8 MiB，硬上限 64 MiB；
- 内容匹配支持整段、逐行、JSON 转义、Base64/Base64URL、Hex。

## 逃生舱

当前项目可放置：

```text
.opencode/sensitive-protection.json
```

```json
{ "enabled": false }
```

只关闭当前 project/location 的保护，不影响加解密插件。

## 数据

登记表保存到：

```text
<XDG_DATA_HOME 或 ~/.local/share>/opencode/sensitive-protection/registry.json
```

只保存路径和 metadata，不保存文件内容。

## 边界

插件 hook 不能保证所有编码、压缩、拆分、MCP/子 Agent 内部操作都被识别；强隔离需要 OS 沙箱或独立用户。
