# @max10240/opencode-plugin-image-gen

使用目标 provider 的认证与部署配置生成或编辑一张图片，保存到文件；不覆盖已有文件，自动使用 `-v2` 等名称。
插件可独立使用，不读取或猜测认证文件，也不把图片内容返回模型对话。

## 使用

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [{
    "package": "@max10240/opencode-plugin-image-gen",
    "options": { "model": "gateway/gpt-image-2.5-sunburst" }
  }],
  "providers": {
    "gateway": {
      "package": "@opencode/ai/providers/openai-compatible",
      "settings": { "baseURL": "https://gateway.example/v1" },
      "headers": { "Authorization": "{env:GATEWAY_AUTH}" }
    }
  }
}
```

```json
{ "prompt": "A red kite", "out": "kite.png" }
```

有参考图时增加 `images`，路径相对当前 session 目录；无参考图生成，有参考图编辑。
可选字段 `model`、`quality`、`size`、`images` 均接受 `null`，与未提供相同，调用图片 API 前会移除。
必填字段 `prompt`、`out` 仍只接受字符串。
OpenAI-compatible endpoint 必须支持 `/images/generations` / `/images/edits`，能对话不代表能生图。
支持 base64、图片 URL 和 data URL 结果；URL 下载不携带生成请求的认证头，也不会重复发起生图。
OpenAI-compatible 响应的可选元数据接受 `null`；兼容解析仍校验字段类型，并拒绝损坏的 base64、空内容和 HTTP 错误，不重新生图。
并发保存同一路径时以独占创建方式分配版本名，避免互相覆盖。

## 模型与配置

优先级：工具参数 `model` → 插件 `options.model` → `openai/gpt-image-2.5-sunburst`。
默认 provider 仍为 OpenAI，不自动跟随会话。其他 provider 应填写完整的 `provider/model`。

- 可以使用不在语言模型 catalog 中的图像模型，继承目标 provider 的配置。
- 支持 `provider/model#variant`。与当前 session 模型相同时，未指定 variant 会继承 session 的选择；
  `#default` 使用基础配置。不存在的 variant 明确报错，不悄悄丢弃。
- provider/model/variant 的 settings、headers、body 按 Core 的方式合并；header 名称不区分大小写。
- 自定义 URL 推荐放在 provider settings；`options.baseURL` 是显式覆盖。`${NAME}` 未解析时拒绝请求。
- 支持 GPT Image 2.5 Sunburst、Flare 及明确 snapshot。`quality` 可选 `low/medium/high/xhigh/max/auto`，
  `xhigh/max` 需要目标模型支持。默认模型是维护时核对的值，不自动联网升级。

## 认证

- 使用 Core `integration.connection.active/resolve` 选择当前连接，包括 provider 声明的环境变量、保存的 key/OAuth
  和刷新流程；凭据解析失败会传播错误，不降级换认证或换 endpoint。
- 没有 active connection 时仍支持 `settings.apiKey`、配置认证 headers 和显式启用的匿名部署。
- 已选凭据优先于配置 key。保留 key configuration；key metadata 可合入 body，OAuth metadata 不作为 body。
- 先通过原生 provider 的 model 工厂准备认证和 HTTP 上下文，再用于图片协议；保留该工厂的 organization/project、
  query 等映射，不把所有认证都重写为 Bearer，也不把自定义 provider 回退到环境中的 OpenAI key。
- 支持原生 OpenAI、OpenAI-compatible、Google、xAI、Meta、ZAI 图片适配器，以及可加载并提供
  `configure().image()` 的原生自定义工厂。常见已知 AISDK 名称可映射到原生实现；其他不支持的 package 明确报错，
  不因存在 baseURL 就猜测 OpenAI 协议。自定义 package 必须能从插件加载，或使用 file URL。

### 明确限制

当前公开插件 API 不能触发其他插件的 session `model.request/http.request/http.response` hooks。
**仅在这些 hooks 中提供的签名、路由或其他认证不会自动继承**；本次没有修改 Core，也不宣称此类部署已支持。
原生 provider 工厂产生的 `Auth.Definition` 会用于图片的新 URL/body，合成动态签名已有测试覆盖。

运行时提供工具 `signal` 时，取消会中止生成和图片下载；旧版 Promise 工具 API 未提供该信号时无法保证中止远端请求。

未用真实云账号验证 ADC/AWS/Azure 等所有认证组合。目标 package 若没有图片适配器就拒绝调用，而不是套用
不兼容协议。OpenAI 订阅路由沿用 Core 已解析的 provider URL 和 headers；账号的图像权限由服务端判断。

## 可选预览与 Unicorn

`show_img` 可用时，保存后直接调用它准备用户预览，只在 metadata 中携带 ID/文件名；不要求模型额外发起调用。
缺失、关闭或预览失败均不影响生图结果，不会重试生图或删除输出。只加载 image-gen 仍可正常保存图片。

Unicorn 的 `features.imageGen` / `features.showImg` 分别控制生图和预览；生图参数放在 `options.imageGen`，
例如 `options.imageGen.model`、`options.imageGen.baseURL`，对象原样透传给独立插件。

## 验证与证据

```sh
bun run --cwd packages/opencode-plugin-image-gen build
bun run --cwd packages/opencode-plugin-image-gen test
bun run check
node research/run-image-gen-auth-parity.mjs
```

测试使用本地 mock，不调用收费模型。覆盖认证抓包、variant、生成/编辑、错误不降级、自定义工厂签名、可选预览，
以及真实 npm 安装包和 Unicorn 集成。调研证据与修复状态见
[`research/image-gen-auth-parity.md`](../../research/image-gen-auth-parity.md)。
当前使用 `@opencode/ai >=2.2.0`，已在 OpenCode `v2.0.21` 和 `v2.1.0` 完成完整回归。

模型发现数据可参考 [models.dev](https://models.dev/api.json)、[OpenAI models API](https://developers.openai.com/api/reference/resources/models/methods/list)
和 [OpenRouter](https://openrouter.ai/api/v1/models)。列表可能滞后，或只描述第三方路由；不能单纯按日期排序自动换默认模型，
还需核对图像输出能力、协议、账号权限及参数兼容性。
