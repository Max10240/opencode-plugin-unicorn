# @max10240/opencode-plugin-image-gen

OpenCode V2 的生图可行性验证子包。它优先使用 OpenCode `@opencode/ai` 的 native image adapter；没有 native adapter 时使用标准 OpenAI-compatible Images API：

- 无参考图：`POST /images/generations`
- 有参考图：`POST /images/edits`

不会调用 `chatgpt.com/backend-api/codex/responses`，也不会使用 `image_generation` hosted tool；但会沿用 OpenCode 为 ChatGPT OAuth provider 配置的 **baseURL 和标准请求 headers**，然后在该 baseURL 下调用 `/images/*`。

## 当前状态

这个版本是 PoC，支持两类 provider/model：

1. `image_gen` 工具优先使用工具参数 `model`。
2. 没有工具参数时使用插件配置的 `options.model`。
3. 没有插件配置时默认使用 `openai/gpt-image-2.5-sunburst`，不再借用当前 session 的语言模型。
4. 凭据通过 OpenCode V2 的 integration API 解析；没有连接时回退到 `OPENAI_API_KEY`。
5. 对 `openai`、`google`、`xai`、`zai`、`meta` 使用 `@opencode/ai` 对应的 native image adapter；`openai-compatible` 和未知 custom package 回退到标准 OpenAI Images wire format。
6. OpenAI ChatGPT OAuth 使用 OpenCode provider 已解析的 `https://chatgpt.com/backend-api/codex` baseURL、`originator`、`x-codex-beta-features` 和 `chatgpt-account-id`，但请求路径仍然是标准 `/images/generations` 或 `/images/edits`。

provider/model 的 `package`、`modelID`、`settings`、`headers`、`body`、provider baseURL、integration credential 和 key configuration 都从 OpenCode 已解析的 model catalog 进入请求；不会重新读取或猜测全局配置文件。

这不等于“所有 provider 都必然能生图”：provider 必须提供 native image adapter，或实现 OpenAI-compatible `/images/*` 协议。只有语言模型、没有图片 endpoint/adapter 的 provider 会明确报不支持，而不会伪造一个不兼容请求。

配置示例：

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "@max10240/opencode-plugin-image-gen",
      "options": {
        "model": "openai/gpt-image-2.5-flare"
      }
    }
  ]
}
```

模型优先级为：工具参数 `model` → 插件 `options.model` → 内置默认 `openai/gpt-image-2.5-sunburst`。
推荐填写完整的 `provider/model`；只写 model ID 时使用当前 session 的 provider（session 没有模型时使用 `openai`）。
图片模型不必出现在 OpenCode 的语言模型 catalog 中：没有对应条目时继承目标 provider 的 URL、headers、body、
package 和 integration 配置，不会借用其他语言模型的专属配置。自定义 endpoint 应放在 provider settings，或使用
插件 `options.baseURL`。API 权限或模型不可用时如实返回错误，不会悄悄换回语言模型。

### 最新 OpenAI 图像模型

2026-10-02 核对 [OpenAI 官方模型页](https://developers.openai.com/api/docs/models/gpt-image-2.5-sunburst)
及 [Image API 指南](https://developers.openai.com/api/docs/guides/image-generation)：

- `gpt-image-2.5-sunburst`：官方推荐的高能力生成/编辑模型，本插件默认使用它。
- `gpt-image-2.5-flare`：更快的日常生成模型，可通过 `options.model` 或工具参数选择。
- 两者默认 snapshot 均为 `2026-09-08`；需要固定版本可配置完整 snapshot ID。
- 这不是一个名为 `gpt-image-2.5` 的通用模型 ID；请使用上述官方名称。
- 两者支持 `low`、`medium`、`high`、`xhigh`、`max`、`auto`；新增的 `xhigh`/`max` 已加入工具参数。其他 provider/旧模型
  是否支持某个档位仍以其 API 为准。

这里的默认值是发布时确认的模型，并非运行时联网自动更新。单元测试和真实 OpenCode E2E 使用本地 mock，
验证默认模型、配置/参数覆盖、snapshot、生成和编辑请求，以及可选预览；不代表当前账号已获生产模型权限。

## 可选自动预览

图片成功保存后，插件会从当前工具注册表查找 `show_img`。存在时，以实际保存的绝对路径调用它（包括避免覆盖而
生成的 `-v2` 等路径），并只把预览 ID/文件名写入 `image_gen` 的 metadata，由 show-img 的 TUI 入口通过 RPC 展示。
生成和编辑都支持，模型不需要再发起一次 `show_img` 调用。

`@max10240/opencode-plugin-show-img` 是可选协作插件，不是 image-gen 的依赖。没有安装、已关闭、注册表读取失败，
或预览工具执行失败时，image-gen 仍正常返回已保存的图片路径，不展示图片，也不会把图片字节/base64/data URL
加入模型对话。不会因预览失败重试生图或删除已生成文件；无 TUI client 时仅准备预览引用，不声称已经展示成功。

独立使用时，可同时加载两个包（顺序不限）：

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    "@max10240/opencode-plugin-image-gen",
    "@max10240/opencode-plugin-show-img"
  ]
}
```

只加载 image-gen 则只保存图片。在 Unicorn 中，`features.imageGen` 与 `features.showImg` 分别控制生图和预览；
关闭预览不影响生图，关闭生图也不影响通过 `show_img` 展示已有图片。

## OpenAI 订阅验证结果

本节记录此前 GPT Image 2 等模型的实测，不代表 GPT Image 2.5 已使用订阅凭据实测。

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

当前 OpenCode `openai` 语言模型 catalog 查询到的模型为：

```text
openai/gpt-6-astra
openai/gpt-6-astra-fast
openai/gpt-5.6-sol
openai/gpt-5.6-sol-fast
openai/gpt-5.6-luna
openai/gpt-5.6-luna-fast
openai/gpt-5.6-terra
openai/gpt-5.6-terra-fast
openai/gpt-5.5
openai/gpt-5.5-fast
openai/gpt-5.3-codex-spark
```

`gpt-image-2` 不在这个语言模型 catalog 中，但显式配置 `openai/gpt-image-2` 后，Images endpoint 实测返回 `200`，并由插件成功保存为 PNG（`1254x1254`）。这也是为什么插件对显式配置的图片模型允许使用 catalog 外的 model ID。

## 开发

```bash
bun install
bun run --cwd packages/opencode-plugin-image-gen typecheck
bun run --cwd packages/opencode-plugin-image-gen test
```

后续只有在确认目标 provider 的标准 Images endpoint 和凭据权限后，才扩展 provider/model 适配；不同 provider 未必使用相同路径、认证方式或 multipart schema。

## 自动发现图像模型的 JSON 数据源

2026-10-02 实际读取并核对：

| 数据源 | 可用于筛选的字段 | 局限 |
| --- | --- | --- |
| [`models.dev/api.json`](https://models.dev/api.json) | provider、`modalities.output`、`release_date` | 已含图像模型，但本次读取的 OpenAI 列表尚未包含 GPT Image 2.5；不能单独保证最新。 |
| [`api.openai.com/v1/models`](https://developers.openai.com/api/reference/resources/models/methods/list) | `id`、`created`、`shutdown_date` | 需要 API 凭据；返回账号可见模型，但没有 image-output 或 Image API endpoint 能力字段，`created` 也不等于版本优先级。 |
| [`openrouter.ai/api/v1/models`](https://openrouter.ai/api/v1/models) | `architecture.output_modalities`、`created` | 只覆盖 OpenRouter 的模型和路由，ID/接口未必与 OpenAI Image API 相同。 |

因此可以自动**发现候选模型**，但不能简单按日期排序就把第一项设成默认值。还要验证目标 provider、生成/编辑
endpoint、账号权限、稳定版/preview/mini/snapshot 关系，以及质量/尺寸参数兼容性。`input` 包含 image 仅表示能看图，
筛选生图候选必须看 `output`。

建议后续采用“可选自动发现 + 缓存 + 已验证默认值回退”：显式工具参数/用户配置始终最高优先级，刷新失败不阻塞
工具，也不改用户配置；由维护流程根据官方文档审核更新内置默认值。目前未引入任何强制联网发现依赖。
