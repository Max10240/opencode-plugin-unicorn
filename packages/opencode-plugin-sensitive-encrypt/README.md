# @max10240/opencode-plugin-sensitive-encrypt

用配置的 RSA 公钥加密 `$TMPDIR` 下的单个敏感文件。明文不进入模型上下文；插件只读取临时文件。

## 启用

独立使用：

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [{
    "package": "@max10240/opencode-plugin-sensitive-encrypt",
    "options": { "enabled": true }
  }]
}
```

Unicorn 默认关闭，需显式开启：

```jsonc
{
  "plugins": [{
    "package": "@max10240/opencode-plugin-unicorn",
    "options": {
      "features": { "sensitiveEncrypt": true },
      "sensitiveEncrypt": { "enabled": true }
    }
  }]
}
```

## 公钥

默认使用全局配置目录下的 `sensitive-encrypt/public.pem`，例如
`~/.config/opencode/sensitive-encrypt/public.pem`。全局目录遵循 `OPENCODE_CONFIG_DIR`，
其次 `$XDG_CONFIG_HOME/opencode`，默认 `~/.config/opencode`。

启用时只检查公钥文件：

- 存在：直接加载使用，不检查、不读取、不推导私钥。
- 不存在：生成一对 RSA-3072 密钥，写入 `public.pem` 和 `private.pem`；之后插件不再感知私钥。
- 私钥可随时移走；只要公钥存在，后续启动正常加密。
- 公钥缺失但私钥已存在：不读取私钥、不覆盖，直接失败并提示恢复公钥或移走旧私钥。
- 公钥无效：失败关闭，不自动生成新公钥。

默认文件权限：目录 `0700`，私钥 `0600`，公钥 `0644`。

OpenCode 配置支持 `{env:...}` 和 `{file:...}`。也可以显式指定：

```jsonc
"options": {
  "publicKey": "{file:~/.config/opencode/sensitive-encrypt/public.pem}"
}
```

```jsonc
"options": {
  "publicKeyFile": "~/.config/opencode/sensitive-encrypt/public.pem"
}
```

`publicKey` 和 `publicKeyFile` 互斥。`publicKey` 接受 PEM 或单行 base64 DER；环境变量缺失时为空，
插件会失败关闭。`maxBytes` 默认 `1048576`，上限 `67108864`。

## Tool

```text
encrypt_sensitive
```

Description：

```text
Encrypt a single file under $TMPDIR with the configured public key only when the user explicitly requests it. Create it with `mktemp` and a shell redirect or pipe; never use the write/read tools, cat, or any other method that puts its contents in context. If `out` is used, keep it under $TMPDIR. Example: `tmp=$(mktemp "${TMPDIR:-/tmp}/secret.XXXXXX") && printf '%s' "$SECRET" > "$tmp" && echo "$tmp"`, then call `{"file":"<printed path>","out":"$TMPDIR/secret.ocsec"}`.
```

输入：

- `file`：必填，`$TMPDIR/...` 或系统临时目录内的绝对路径。
- `out`：可选，密文输出路径，也必须在 `$TMPDIR` 下；覆盖普通文件是原子的，拒绝 symlink 和目录。

示例：

```sh
tmp=$(mktemp "${TMPDIR:-/tmp}/secret.XXXXXX") || exit 1
printf '%s' "$SECRET" > "$tmp"
echo "$tmp"
```

使用上一步打印的路径：

```json
{ "file": "<printed path>", "out": "$TMPDIR/secret.ocsec" }
```

没有 `out` 时返回 `ocsec1:` 密文；密文超过 256 KiB 时必须使用 `out`。单个文件一次调用；多个文件重复调用。

文件必须是普通文件，且在非 Windows 平台上不能对 group/other 可读；推荐用 `mktemp` 创建。加密完成后应删除临时明文文件。

## 加密格式

`ocsec1:` 后接 base64url JSON：

```json
{
  "v": 1,
  "alg": "RSA-OAEP-256+A256GCM",
  "kid": "...",
  "ek": "...",
  "iv": "...",
  "ct": "...",
  "tag": "..."
}
```

RSA-OAEP-SHA256 包裹随机 256-bit AES 密钥，AES-256-GCM 加密正文；每次使用新的 AES 密钥和 IV。
`kid` 是公钥 SPKI DER 的 base64url SHA-256 指纹。AAD 为：

```json
{"v":1,"alg":"RSA-OAEP-256+A256GCM","kid":"..."}
```

## 解密

不提供 CLI。将下面脚本保存为 `decrypt.mjs`，使用 Node.js 22+：

```js
import {
  createDecipheriv,
  createHash,
  createPrivateKey,
  createPublicKey,
  constants,
  privateDecrypt,
} from "node:crypto"
import { readFileSync } from "node:fs"

const [envelopeFile, privateKeyFile] = process.argv.slice(2)
if (!envelopeFile || !privateKeyFile) {
  console.error("Usage: node decrypt.mjs <envelope-file> <private-key.pem>")
  process.exit(2)
}

const armored = readFileSync(envelopeFile, "utf8").trim()
if (!armored.startsWith("ocsec1:")) throw new Error("Unsupported envelope")
const envelope = JSON.parse(
  Buffer.from(armored.slice("ocsec1:".length), "base64url").toString("utf8"),
)
if (envelope.v !== 1 || envelope.alg !== "RSA-OAEP-256+A256GCM") {
  throw new Error("Unsupported envelope version or algorithm")
}

const privateKey = createPrivateKey(readFileSync(privateKeyFile))
const publicKey = createPublicKey(privateKey)
const kid = createHash("sha256")
  .update(publicKey.export({ type: "spki", format: "der" }))
  .digest("base64url")
if (kid !== envelope.kid) throw new Error("Envelope key does not match the private key")

const aesKey = privateDecrypt(
  {
    key: privateKey,
    padding: constants.RSA_PKCS1_OAEP_PADDING,
    oaepHash: "sha256",
  },
  Buffer.from(envelope.ek, "base64url"),
)
const aad = Buffer.from(JSON.stringify({
  v: envelope.v,
  alg: envelope.alg,
  kid: envelope.kid,
}))
const decipher = createDecipheriv(
  "aes-256-gcm",
  aesKey,
  Buffer.from(envelope.iv, "base64url"),
  { authTagLength: 16 },
)
decipher.setAAD(aad)
decipher.setAuthTag(Buffer.from(envelope.tag, "base64url"))
process.stdout.write(Buffer.concat([
  decipher.update(Buffer.from(envelope.ct, "base64url")),
  decipher.final(),
]))
```

```sh
umask 077
node decrypt.mjs "$TMPDIR/secret.ocsec" \
  ~/.config/opencode/sensitive-encrypt/private.pem > secret.txt
```

脚本会校验版本、算法、`kid`、GCM tag 和 AAD；密钥不匹配或密文被修改都会失败。明文输出到 stdout，
请只重定向到受保护的位置。

## 安全边界

- 只加密，不签名；任何人都能用公钥生成密文，GCM 只提供完整性。
- 没有前向保密；私钥泄露可解密历史密文。
- 自动生成的私钥位于全局配置目录；如果该目录会同步或共享，请把私钥移到离线位置，只保留 `public.pem`。
- 删除公私钥会导致新启动生成新密钥，旧密文无法用新私钥解密。
- Tool description 只是模型指令，不能阻止模型用 `cat` 等方式把明文带入上下文；插件只保证自身不读取、不返回、不记录明文。
- `out` 覆盖普通文件；明文输入文件不会被删除。加密后请自行清理临时明文。
