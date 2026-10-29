# image-gen 与普通对话的请求认证一致性调研

[English](image-gen-auth-parity.md) | **简体中文**

初始调研：2026-10-17；复审：2026-10-20。下表保留修复前的抓包结论，不读取真实凭据、不调用收费模型。

## 实施状态

已按“仅修改当前插件”的范围完成配置认证、匿名部署、连接优先级、variant、原生工厂 HTTP/auth 映射修复。
未修改 Core；R7 的 session hooks 限制仍保留。复现入口现调用正式
[`auth-e2e.test.ts`](../packages/opencode-plugin-image-gen/test/auth-e2e.test.ts)，已修复项目断言成功路径，
并保留签名 hook 缺失时的失败断言，另增加原生自定义工厂签名测试。

### 复审修复与证据

- Meta/ZAI 不在 Core 的匿名认证覆盖集合中（`model-resolver.ts:423-458`），不能因显式启用就改成 Auth.none。
  正式抓包用合成环境 key 验证根入口及语言子入口，子入口复用同族图片适配器。
- OAuth 参数按 Core 的精确 package 规则映射（`:303-314`），不按自定义文件名中的关键词猜测；
  `test/deployment.test.ts` 覆盖包含 provider 关键词的自定义 package。
- 调研 SDK `2.0.15` 的 `route/media.js:28-30` 先应用 endpoint query，再应用 HTTP query；现在保留两者且遵循该优先级，
  部署单测及原生工厂签名抓包均有断言。工厂返回的未解析 URL 同样拒绝调用。
- JSON 合并只读取自有属性，`test/overlay.test.ts` 覆盖 constructor/toString/__proto__，不修改原始配置。
- `test/setup.test.ts` 验证注册工具的 URL 覆盖优先级、OAuth metadata 隔离、旧运行时无 signal 时正常生成，
  以及提供 signal 时取消不写文件；生成和下载的中途取消另有 HTTP 测试。
- 当前 `@opencode/plugin 2.0.10` 的 Promise adapter 没有向工具传入取消信号
  （安装包 `dist/promise/adapter.js:444-447`）。插件兼容可选 signal，不宣称旧运行时能够中止远端请求。

2026-10-20 复审补充：

- `model.test.ts` 复现并覆盖 bare model 的 variant 含 `/` 时误判 provider；解析器现在先分离 variant。
- `deployment.test.ts` 覆盖 canonical provider 同时传入语言与图片工厂，不被 settings 中的旧值覆盖。
- 共用 E2E server 与认证子进程改用环境白名单；`e2e-environment.test.ts` 验证不继承真实 key、代理、
  配置覆盖或预加载脚本，显式 self-config 测试选项仍有效。
- 实测 `v2.1.0` 会拒绝旧图片 SDK 引用的 `effect/dist/unstable/http/index.js`；
  图片 SDK 最低版本改为 `2.1.1`，未更改其他插件的 SDK 下限、Core 或全局配置。
- 新 SDK 的 OpenAI 图片解码只接受 b64_json。`openai-image-result.ts` 兼容 URL/data URL 结果和可选响应元数据的 null：
  仅解析已收到的 OpenAI 图片响应，不重试生图、不改变认证；Schema 验证拒绝无效数据和认证错误。
  `openai-images.test.ts` 验证生成/编辑、nullable 响应、URL 下载、认证不转发和下载取消，`openai-image-result.test.ts` 覆盖解析边界。
- `auth-e2e.test.ts` 增加 `header-only-edit`、`header-only-rejected`：真实 OpenCode 发送 multipart 参考图，
  本地网关校验 Basic/X-API-Key；拒绝认证时仅有一次图片请求、工具返回错误且没有输出文件。

`bun run check` 在 `v2.1.0`、隔离安装的 `v2.0.21` 上分别通过 **238 项、0 失败**（保留原 211 项，新增 27 项测试优化回归），含六包类型检查、
真实 npm tarball 安装及 TUI/Unicorn 回归。另有 3 项隔离/清理测试；认证抓包入口也在两版重新运行。

2026-10-28 复审补充：

- `@opencode/ai` 升至 `2.2.0`：Promise 客户端改为主入口 `make()`，`Media`/`ImageModel`/`LanguageModel` 改从 `@opencode/ai/effect` 导入；
  图片请求改用 `aspect`/`resolution`/`providerOptions`。
- 2.2.0 不再读取响应项的 `mime_type`；兼容响应缺少 `output_format` 时先按字节识别，再回落到请求的 PNG 格式。
  `openai-image-result.ts` 继续处理 null 元数据和 URL/data URL 结果。
- `npm run check` 通过，含图片插件 119 项测试与 packaged E2E。

## 验证范围

- 原始抓包服务：`opencode v2.0.21`；复审同时验证 `v2.1.0`。
- 原始抓包依赖：`@opencode/plugin 2.0.10`、`@opencode/ai 2.0.15`；当前图片 SDK 为 `2.2.0`，直接声明 `effect ^4.0.1` 用于兼容响应的 Schema 验证。
- OpenCode 参考源码仓库，commit `07501ee86740ae1cef97f1c43819f3b98d783fd6`；引用的源码文件没有工作区改动。
- 参考源码与已安装 binary 不是同一版本：下表“实测”只承诺上述 binary/SDK；上游实现另以源码和上游单测验证。
- 所有抓包只发生在隔离 HOME/config/database 和 localhost 服务之间。key、Basic header、HMAC secret 全部为合成测试数据。
- 推荐使用下方隔离入口：自动构建当前源码，白名单传递环境变量，不继承账号、代理或配置覆盖；macOS 上用
  sandbox-exec 强制只允许 localhost 出站连接。其他平台没有该 OS 网络限制，仍使用临时 HOME 和本地 endpoint。
- Unix 平台失败、超时或 SIGINT/SIGTERM 会清理入口创建的子进程组和临时 HOME；Windows 只清理直接子进程，
  没有验证进程树清理。探针只在测试 server 内设置合成变量。

## 已验证结论与实验

实验代码：[`image-gen-auth-parity.test.ts`](./image-gen-auth-parity.test.ts)。每个实验比较实际网络请求或明确断言当前失败点。

| 编号 / 测试名称 | 普通对话 | 修复前 image_gen | 结论 |
| --- | --- | --- | --- |
| R1 `header-only` | 没有 active connection，仍使用配置的 Basic Authorization 和 X-API-Key 完成对话 | `No active credential found`，没有发出图片 HTTP 请求 | header 认证不能以“必须找到 credential”为前提。 |
| R2 `inline-key` | 没有 active connection，使用 `settings.apiKey` 生成 Bearer header | 同样在发请求前失败 | 配置中的 apiKey 是有效认证来源，不等于已保存 credential。 |
| R3 `anonymous` | 显式配置的 provider 无 Authorization 也能完成对话 | 同样在发请求前失败 | 无认证 endpoint 也是有效部署，不能强加 token。 |
| R4 `declared-env` | `provider.env` 声明的测试变量通过 connection API 解析为 key | Bearer 与普通对话相同，图片成功 | 现有 connection API 已覆盖声明的环境变量；不要再自行寻找认证文件。 |
| R5 `saved-key` | 已保存测试 key 覆盖配置中的另一个 apiKey | 同样使用已保存 key，图片成功 | 不能简单让 settings.apiKey 永远优先；应保留 Core 的连接选择和优先级。 |
| R6 `variant` | 使用 premium variant 的 URL、headers、body | 使用基础模型 URL/headers/body，variant 丢失 | 模型列表不等于选定 variant 的完整运行时参数。 |
| R7 `signed-hook` | `model.request` 改 URL；`http.request` 对 method/URL/body 做合成 HMAC，服务验签通过 | 未进入这两个 session hooks，仍用原 URL，缺少签名，服务返回 401 | 只复制 catalog 参数或之前聊天的 headers，无法复用请求级认证流程。 |
| R8 `organization` | native OpenAI 工厂将 organization/project 转成 HTTP headers | 图片请求缺少这两个 headers | 直接调用 configure().image() 绕过了普通对话 model() 工厂的 settings 映射。 |
| R9 `implicit-default` | 会话使用自定义 provider 和它的 key | 未给工具指定模型时，转向 OpenAI provider 和默认图像模型 | 认证问题和目标 provider 选择是两个问题；当前默认 provider 并不跟随会话。实验中的 OpenAI endpoint 也被替换为本地服务。 |
| R10 `making credentials optional alone...` | 独立的图片 SDK 调用实验 | 省略 token 后，settings.apiKey 被 undefined 覆盖；SDK 改用合成 OPENAI_API_KEY 并覆盖配置的 Basic header | 仅删除“无 credential 就报错”还不够；不能对自定义 provider 无条件使用 OpenAI 的环境认证回退。 |
| R11 `SDK feasibility: reuse a provider model's prepared HTTP/auth context...` | 先由 native model() 工厂准备上下文 | 将准备后的 auth、headers、HTTP body/query 和 baseURL 用于明确兼容的图片路由，合成 key、organization/project、自定义 header、query/body 均正确 | SDK 层已有复用运行时认证对象的可行基础；不是只能传 token 字符串。 |
| R12 `SDK feasibility: transferring Auth.Definition...` | 构造带合成动态签名的运行时认证对象 | 图片请求使用同一 Auth.Definition，按图片自己的 URL/body 重新签名，验签成功 | 应复用认证行为，而不是复用上一条请求的最终签名值。 |

同一组实验还验证：

- provider/model 的 headers 与嵌套 body 已被 Core 合并，header 名称合并不区分大小写；catalog probe 得到的仍是基础模型，不含当前 variant。
- `queryParams` 不是通用的“必定变成 URL query”设置：本次普通对话的 native OpenAI 工厂会映射它，openai-compatible 工厂没有；修复前图片 fallback 却统一按 OpenAI 工厂处理。必须尊重目标 package 的参数语义。
- 普通对话带 `x-opencode-session-id`，修复前图片调用没有。该项是会话关联信息，不把它本身认定为认证凭据。
- 运行时 probe 中 `ctx.model.resolve`、`ctx.model.resolveImage`、`ctx.generate.image` 均为 undefined。不能把这些当成现有插件 API。

## 普通对话的实际链路：源码证据

以下路径均相对 OpenCode 源码仓库：

| 环节 | 证据 |
| --- | --- |
| 配置的 provider 可显式启用，不要求已保存 key | `packages/core/src/config/plugin/provider.ts:54-74` 设置 activation=enabled，并合并 settings/headers/body。 |
| provider → model 合并 | `packages/core/src/model.ts:190-200`；`packages/core/src/provider.ts:147-179` 实现深合并和大小写无关的 header 覆盖。 |
| variant 覆盖 | `packages/core/src/model-resolver.ts:137-160`；`packages/core/src/session/runner/model.ts:90` 将 session.model.variant 交给 resolver。 |
| 选择集成连接 | `packages/core/src/model-resolver.ts:359-370` 根据 provider.integrationID/providerID 调 active/resolve。没有 connection 时 credential 为 undefined，而不是立即拒绝。 |
| 环境变量、已保存凭据与 OAuth 刷新 | `packages/core/src/integration.ts:369-382,692-713`；active connection 包括保存的 credential 和声明的 env，resolve 负责取值及需要时的刷新。 |
| 准备运行时 provider | `packages/core/src/model-resolver.ts:196-251` 合并配置/凭据参数，然后调用 package.model()；不是直接将 token 塞入所有 provider 的 apiKey。 |
| 认证类型并不统一 | `packages/core/src/model-resolver.ts:303-314`：key 使用 apiKey，部分 OAuth 使用 authToken 或 accessToken。 |
| key metadata 与 OAuth metadata 不同 | `packages/core/src/model-resolver.ts:254-262`，key metadata 还可合入请求 body；不能把所有 metadata 都无差别当 body 或忽略。 |
| 显式启用的无凭据部署 | `packages/core/src/model-resolver.ts:374-379,417-458` 对满足条件的 API-key provider 使用 Auth.none。 |
| package-specific settings 映射 | `packages/ai/src/providers/openai.ts:136-167` 和 `packages/ai/src/providers/openai-compatible.ts:48-59`，两者不是同一个映射函数。 |
| 会话 headers、model hook、HTTP hook | `packages/core/src/session/model-request.ts:275-317,334-362`。HTTP hook 是执行中间件，不在 catalog 中。 |
| 认证支持函数而不只是字符串 | `packages/ai/src/route/auth.ts:20-40,68-71,106-113`；AuthInput 包含 method/URL/body，Auth.custom 可以逐请求生成 headers。 |
| SDK 图像请求能使用 auth/HTTP 上下文 | R11/R12 已实际发送请求；对应的当前安装 SDK 为 `@opencode/ai/dist/providers/openai.js:47-52`。 |

已执行上游单测：

```sh
cd <opencode-source>/packages/core
bun test test/model-resolver.test.ts
bun test test/integration.test.ts
```

结果：45 + 16 项通过，0 失败。覆盖 configured/stored key 优先级、空 key、无 key 显式启用、variant、OAuth 参数映射、credential/env connection 等。
其中 `model-resolver.test.ts:711-753` 明确断言 key metadata 可以进入 body，而 OAuth metadata 不作为 body；`:911-947` 验证不同 package 的 OAuth 参数名。
这些是合成凭据单测，不代表运行过真实 OAuth、ADC、AWS 或 Azure 账号。

## 修复前插件的具体偏差：仓库证据

本节路径和行号对应修复前 commit `ee5a328`，不是当前实现；修复代码位于 image-gen 的 `deployment.ts`、
`credential.ts`、`model.ts` 和 `overlay.ts`。

- `packages/opencode-plugin-image-gen/src/credential.ts:11-31`：只有 active connection 或 OpenAI 环境 key 才返回；否则抛错。这里没有手动读取 auth.json，问题是把 connection 变成了强制前置条件。
- `src/index.ts:50-76`：必须先 resolveCredential；metadata/configuration 只展开到 settings，HTTP hooks 没有从 Core 传入图片 client。
- `src/model.ts:22-35,46-49`：去掉 `#variant`，没有执行 variant overlay；不指定模型时使用固定 OpenAI 默认值。
- `src/openai-images.ts:74-83`：固定写入 `apiKey:request.token`，会覆盖 settings.apiKey；调用 configure().image()，不经过 native package.model() 的普通对话映射。
- `src/openai-images.ts:125-138`：未知 package 或 openai-compatible 可按 baseURL 回退 OpenAI。R8/R10 和 query 抓包说明这不是无损转换。

## 怎么实现

### 必须保持的语义

1. 明确目标图像 provider/model/variant，解析该目标的参数；不要混入另一会话模型或另一 provider 的 key。
2. 复用 Core 的 provider/model/variant 合并、active connection 选择及 credential resolve；没有 connection 不等于没有认证，也不等于报错。
3. 保留 package 原生的认证和 settings 映射：配置 key、header-only、anonymous、provider.env、保存的 key/OAuth，以及其原生支持的动态认证。
4. 在兼容的图片协议上复用准备好的认证/HTTP 上下文，重新为图片的 method/URL/body 认证；R11/R12 已验证 SDK 可行性。
5. 若要求包含所有 session hooks，必须共享相同的请求中间件。R7 证明另起一个 AI client 不会自动继承它。
6. 只改变图片协议所需的模型/prompt/images/size/quality 等 payload；不能将聊天的 messages/tools/max_tokens 整份照搬到 Image API。

### 推荐落点

最稳妥的是由 Core 暴露公共的“准备图像 deployment/执行图像请求”能力，复用 ModelResolver 的配置/凭据处理和 session 请求中间件。
返回或内部持有可执行的 Auth.Definition/HTTP context，而不是把凭据序列化给模型。**这是建议扩展，不是当前已经存在的 API。**

证据：当前公开 ModelDomain 只有 catalog/API 及 transform/reload（本仓库安装的 `@opencode/plugin/dist/promise/model.d.ts:26-29`），运行时 probe 也没有 resolve/image API；
Core `ModelResolver.Interface` 的 resolve/resolveModel 返回 LanguageModel（`:110-131`），不提供外部插件用的图像调用。

本轮按选择仅修改插件，已修复 native/OpenAI-compatible 场景：取消 mandatory credential、使用正确的 provider settings/凭据优先级、执行 variant overlay、复用原生工厂生成的 auth/HTTP context。
这不是“任意 provider + 任意 hooks 完全一致”。AISDK 扩展、云签名、ADC、私有 provider 和请求级 hooks 仍需分别验证或接入共享 Core 通道。

能对话不等于能生成图片：协议和 endpoint 能力仍需单独确认。R11/R12 只对本地明确兼容 OpenAI Images 的 endpoint 成功，不证明任意对话 URL 都支持图片。

## 复现

本仓库推荐入口：

```sh
node research/run-image-gen-auth-parity.mjs
bun test research/runner-isolation.test.ts
```

修复后的入口运行 15 项正式认证/可行性测试；另有 3 项隔离/中断清理测试，以及上述上游 61 项单测。
隔离测试在 macOS 实际验证 localhost 成功、外部 socket 被 OS 拒绝，不以连接超时或目标不可达冒充沙箱证据。
历史实验是版本限定的证据；正式测试已更新为修复后的预期，不要求保留旧缺陷。
