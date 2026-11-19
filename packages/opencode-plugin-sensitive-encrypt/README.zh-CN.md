# @max10240/opencode-plugin-sensitive-encrypt

[English](README.md) | **简体中文**

**处理密钥和敏感信息，不必把它们发进对话。**

有时候 Agent 需要接触敏感信息：API key、私有配置、凭据文件。直接贴进对话，会把它发给模型 provider，还会留在转录里；写进项目的
明文文件也没有好到哪去。如果还要备份或分享，明文文件更不应该出现在 Git 里。

这个插件提供一套简单的加密流程：用公钥加密，用私钥解密，明文永远不会作为工具结果返回。你可以从 TUI 里加密，也可以让 Agent
代劳，而解密永远只写入文件。

## 什么时候需要它

- 需要把敏感信息存进仓库或备份，但不能提交明文。
- 想把加密后的内容交给 Agent 处理，又不想让它看到原文。
- 需要把敏感信息解密到本地文件供命令使用，但不能出现在聊天里。
- 想从 TUI 快速加密一段文本或一个文件。
- 已经用了敏感信息保护插件，想让两者配合。

## 它能给你什么

- **加密和解密使用独立密钥。** 加密只要公钥，解密需要私钥；可以是不同的人，也可以用于不同的用途。
- **文本和文件都能加密。** 多行文本在内存中加密，文件在磁盘上加密。
- **只解密到文件。** 解密工具不会把明文打印到工具输出里。
- **Agent 可直接调用。** 加密文件、解密到目标路径、查看公钥指纹，都有对应工具。
- **TUI 面板。** 用 `/encrypt-sensitive` 或快捷键打开，不必每次都找 Agent。
- **与保护插件联动。** 启用敏感信息保护后，解密私钥、加密输入和解密输出会自动登记。

## 快速开始

独立使用时，server 和 TUI 配置都要加载：

```jsonc
// opencode.jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["@max10240/opencode-plugin-sensitive-encrypt"]
}
```

```jsonc
// cli.json
{
  "$schema": "https://opencode.ai/v2/cli.json",
  "plugins": ["@max10240/opencode-plugin-sensitive-encrypt"]
}
```

通过 Unicorn 使用时，默认开启：

```jsonc
{
  "plugins": [{
    "package": "@max10240/opencode-plugin-unicorn",
    "options": { "features": { "sensitiveEncrypt": true } }
  }]
}
```

默认情况下，插件首次运行时，启用的密钥对会自动生成到 `<全局配置目录>/sensitive-encrypt/`。只有已经拥有密钥时，才需要设置
`publicKeyFileForEncrypt` 或 `privateKeyFileForDecrypt`。配置中的相对路径以全局 OpenCode 配置目录为基准，绝对路径则原样使用。

## 使用

### TUI 面板

运行 `/encrypt-sensitive` 或按配置的快捷键。

- **Text 模式**是默认模式。输入或粘贴多行文本，默认用 `*` 占位符遮蔽显示，按 `ctrl+r` 临时显示或重新隐藏。文本在内存中加密，
  不会写成明文文件。可以额外指定 `$TMPDIR` 下的密文保存路径。加密完成后输入会清空，结果弹窗会显示密文去向。
- **File 模式**（`ctrl+t`）加密 `$TMPDIR` 下的文件。填写源路径和可选的输出路径。
- **Key 选择器**决定用哪个公钥加密。默认使用解密私钥推导出的公钥，所以加密结果可以被本插件解开。

Text 模式下按 `Enter` 加密，按 `Shift+Enter` 插入换行。`Tab` 在输出路径和密钥之间移动，`F1` 查看帮助，`Esc` 关闭。
结果弹窗中按 `Enter` 复制密文并关闭，按 `c` / `Ctrl+Y` 只复制不关闭，按 `p` 复制输出路径。

### Agent 工具

| 工具 | 作用 |
| --- | --- |
| `encrypt_sensitive` | 用配置的公钥加密单个文件，写出 `ocsec1` 信封 |
| `decrypt_sensitive` | 把 `ocsec1` 文件解密到必填的 `out` 路径；明文不会内联返回 |
| `sensitive_key_info` | 显示公钥和指纹；私钥永远不会返回 |

如果希望 Agent 加密的文件能被本插件解密，把 `publicKeyFileForEncrypt` 指向 `sensitive-encrypt/decrypt-public.pem`，
也就是解密密钥的公钥部分。TUI 面板默认就是这样。

## 配置

| 参数 | 默认值 | 作用 |
| --- | --- | --- |
| `enabled` | `true` | 打开或关闭整个插件 |
| `encrypt` | `true` | 启用或关闭加密 |
| `decrypt` | `true` | 启用或关闭解密 |
| `publicKeyForEncrypt` | 自动生成 | 内联公钥（PEM 或 base64 DER） |
| `publicKeyFileForEncrypt` | 自动生成 | 加密所用公钥的路径 |
| `privateKeyFileForDecrypt` | 自动生成 | 解密所用私钥的路径 |
| `maxBytes` | `1048576` | 加密或解密的文件大小上限；硬上限 `64 MiB` |

`publicKeyForEncrypt` 和 `publicKeyFileForEncrypt` 只能设置一个。旧名称 `publicKey` / `publicKeyFile` 仍然兼容。

## 注意事项

- **私钥丢了，数据就回不来了。** 没有恢复通道，请备份密钥文件。
- **私钥以严格权限保存在磁盘上。** 必须是普通文件、权限 `0600`，不接受 symlink。
- **解密只写文件，不进聊天。** 输出以 `0600` 创建，不会覆盖输入文件，也不会跟随 symlink。
- **文件路径必须在 `$TMPDIR` 下。** Agent 工具和 TUI 的 File 模式只读写系统临时目录；作为输入的敏感文件还必须只有你自己可读
  （`0600`）。先把文件放进临时目录，加密后再把密文移到需要的位置。
- **加密不是保险箱。** 它保护存储中的数据，让 Agent 处理密文而不看到明文，但不能阻止 Agent 用其他工具读取解密后的文件。
  需要时请配合敏感信息保护。
- **加密和解密密钥互不校验。** 插件不会检查它们是否配对；要解密自己的输出，请使用匹配的密钥。
- **保护插件是可选的。** 没有它，加解密仍然可用，只是不会自动登记密钥和文件。
