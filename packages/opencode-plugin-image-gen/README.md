# opencode-plugin-image-gen

OpenCode V2 的生图可行性验证子包。它只调用标准的 OpenAI-compatible Images API：

- 无参考图：`POST /images/generations`
- 有参考图：`POST /images/edits`

不会调用 `chatgpt.com/backend-api/codex/responses`，也不会使用 `image_generation` hosted tool；但会沿用 OpenCode 为 ChatGPT OAuth provider 配置的 **baseURL 和标准请求 headers**，然后在该 baseURL 下调用 `/images/*`。

## 当前状态

这个版本是 PoC，当前只接通 `openai` provider：

1. `image_gen` 工具优先使用工具参数 `model`。
2. 没有工具参数时使用插件配置的 `options.model`。
3. 没有插件配置时使用当前 session 的模型。
4. 凭据通过 OpenCode V2 的 integration API 解析；没有连接时回退到 `OPENAI_API_KEY`。
5. OpenAI ChatGPT OAuth 使用 OpenCode provider 已解析的 `https://chatgpt.com/backend-api/codex` baseURL、`originator`、`x-codex-beta-features` 和 `chatgpt-account-id`，但请求路径仍然是标准 `/images/generations` 或 `/images/edits`。

配置示例：

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "opencode-plugin-image-gen",
      "options": {
        "model": "openai/gpt-image-1"
      }
    }
  ]
}
```

如果不配置 `model`，当前 session 模型会原样作为 `/images/*` 请求的 `model`。因此实际使用时应选择支持图片生成的模型，或者配置专用图片模型。

## OpenAI 订阅验证结果

最初直接请求 `https://api.openai.com/v1/images/generations` 会得到缺少 `api.model.images.request` scope 的 401；这是因为 ChatGPT OAuth 不是公共 API key，且 OpenCode 会为它改写 OpenAI provider endpoint。按照 OpenCode 源码使用正确的 provider endpoint 和 headers 后，验证成功：

```text
POST https://chatgpt.com/backend-api/codex/images/generations
model=gpt-5.5
prompt=A single red dot on a white background
quality=low
size=1024x1024
```

服务端返回 `200`，包含 `data[0].b64_json`。实际保存结果为有效 PNG：

```text
bytes: 931206
signature: 89504e470d0a1a0a
output_format: png
```

因此，基于 OpenAI 订阅走 `/images/*` 是可行的；关键是使用 OpenCode provider 的 Codex baseURL/headers，而不是把订阅 token 当成公共 `api.openai.com/v1` API key。这里没有调用旧插件的 `/responses` + hosted `image_generation` hack。

## 开发

```bash
bun install
bun run --cwd packages/opencode-plugin-image-gen typecheck
bun run --cwd packages/opencode-plugin-image-gen test
```

后续只有在确认目标 provider 的标准 Images endpoint 和凭据权限后，才扩展 provider/model 适配；不同 provider 未必使用相同路径、认证方式或 multipart schema。
