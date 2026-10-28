# @max10240/opencode-plugin-sensitive-encrypt

用独立公钥加密、独立私钥解密 `$TMPDIR` 下的敏感文件。明文、私钥不会进入模型上下文。

## Tools

- `encrypt_sensitive`：用 `publicKeyForEncrypt`/`publicKeyFileForEncrypt` 加密单个文件；
- `decrypt_sensitive`：用 `privateKeyFileForDecrypt` 解密 `ocsec1` 信封，**必须写 out 文件**，不 inline 返回明文；
- `sensitive_key_info`：显示加密/解密公钥和 `kid`，不返回私钥。

## 配置

```jsonc
{
  "sensitiveEncrypt": {
    "encrypt": true,
    "decrypt": true,
    "publicKeyForEncrypt": "-----BEGIN PUBLIC KEY-----...",
    "publicKeyFileForEncrypt": "sensitive-encrypt/encrypt-public.pem",
    "privateKeyFileForDecrypt": "sensitive-encrypt/decrypt-private.pem",
    "maxBytes": 1048576
  }
}
```

- `encrypt` / `decrypt` 默认 `true`，可设为 `false` 或 `null` 关闭；
- `maxBytes` 默认 1 MiB，硬上限 64 MiB；
- 加密、解密密钥互不关联，不推导、不校验配对；
- 默认目录为 `<global config>/sensitive-encrypt/`，按角色生成 `encrypt-*`、`decrypt-*` 两对密钥；
- 旧 `publicKey` / `publicKeyFile` 仍静默兼容，等价于新的 encrypt 名称。

## 密钥安全

- 私钥文件必须是普通文件，权限 `0600`，不接受 symlink；
- 每次解密重新读取私钥，不长期缓存；
- 解密输出 `0600`，原子替换，拒绝 symlink 和覆盖输入；
- 私钥丢失后已有密文无法恢复。

## TUI

`/encrypt-sensitive` 或配置 keybind 打开一次性加密弹窗。弹窗不会自动关闭，可复制密文或输出路径；结果不进入模型上下文。

## 保护插件联动

加密/解密成功后，通过运行时发现 `register_sensitive_file` tool，自动登记：

- 加密输入文件；
- 解密输出文件。

保护插件不存在时静默跳过，不影响加解密。
