# @max10240/opencode-plugin-image-gen

[English](README.md) | **简体中文**

**不离开对话，也能生成和编辑图片。**

你在写 README，需要一张头图；你在做界面，想先看个 mockup；你有一张参考图，想试试换个风格。按以前的流程，得离开 OpenCode、
打开图片工具、下载文件，再回来描述你拿到了什么。

有了这个插件，直接开口就行。Agent 生成或编辑图片，保存到项目里；有预览能力时，还会在对话里显示出来。图片字节不会进入模型
上下文，Agent 的注意力仍然在任务上，而不是像素上。

## 什么时候需要它

- 写作时需要插图、图标、mockup 或社交媒体图片。
- 想通过描述来修改或重绘一张现有图片。
- 想把生成的素材直接保存进仓库。
- 不希望图片数据进入模型对话。
- 已经在 OpenCode 里配置了 OpenAI 或其他支持的图片 provider。

## 它能给你什么

- **一句话，一张图。** 用自然语言告诉 Agent，它会替你调用工具。
- **生成或编辑。** 不提供参考图就是新生成；提供参考图就是编辑。
- **安全的文件处理。** 不覆盖已有文件，自动分配 `-v2` 之类的名称。
- **内联预览。** 预览插件可用时，图片显示在工具输出下方，可以放大查看。
- **复用现有 provider 配置。** 使用 OpenCode 里已经配置好的 provider 和凭据，不读取凭据文件，也不猜测密钥。
- **图片字节不进对话。** 模型只拿到确认信息和文件引用，拿不到图片本身。

## 快速开始

在 server 配置中加载。默认模型是 `openai/gpt-image-2.5-sunburst`：

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [{
    "package": "@max10240/opencode-plugin-image-gen",
    "options": { "model": "openai/gpt-image-2.5-sunburst" }
  }]
}
```

如果要用网关或其他 provider，在同一个配置里声明：

```jsonc
{
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

通过 Unicorn 使用时，生图默认开启：

```jsonc
{
  "plugins": [{
    "package": "@max10240/opencode-plugin-unicorn",
    "options": {
      "features": { "imageGen": true, "showImg": true },
      "imageGen": { "model": "openai/gpt-image-2.5-sunburst" }
    }
  }]
}
```

## 使用

直接说：

> 给 README 生成一张极简风格的风筝插图，保存为 `docs/kite.png`。

Agent 会调用 `image_gen`：

```json
{ "prompt": "A red kite", "out": "kite.png" }
```

要编辑现有图片，加上 `images`。路径相对于当前 session 目录。

```json
{
  "prompt": "把天空调暖一点，再加一朵小云",
  "out": "kite-v2.png",
  "images": ["kite.png"]
}
```

可选字段：`model`、`quality`、`size`、`images`。`prompt` 和 `out` 必填。

## 配置

| 设置 | 优先级 | 说明 |
| --- | --- | --- |
| 模型 | 工具参数 → `options.model` → `openai/gpt-image-2.5-sunburst` | 非 OpenAI provider 使用 `provider/model` |
| 质量 | 工具参数 | `low`、`medium`、`high`、`xhigh`、`max` 或 `auto`；`xhigh` 和 `max` 需要模型支持 |
| 尺寸 | 工具参数 | 取决于 provider 支持范围 |
| 参考图 | 工具参数 | 相对于 session 目录 |

默认 provider 是 OpenAI，不会自动跟随当前对话模型。使用其他 provider 时，请写完整的 `provider/model`。你在 provider
中配置的 headers、base URL 和 variant 会被沿用。

## 注意事项

- **Provider 必须支持图片接口。** OpenAI-compatible endpoint 需要实现 `/images/generations` 和 `/images/edits`；
  能对话不代表能生图。
- **生图和预览是分开的。** 预览缺失、关闭或失败，不会影响生成的文件，也不会触发第二次生成。
- **图片是文件引用，不是聊天附件。** 图片保存在磁盘上，模型只拿到路径和预览引用。
- **某些高级认证方式可能需要额外配置。** 如果 provider 依赖其他插件来签名请求或注入路由，那部分行为不在本插件控制范围内。
- **图片权限由 provider 决定。** 凭据有效，不代表账号一定能使用图片模型。
- **云平台认证可能需要额外验证。** AWS、Azure、Google ADC 等 provider 专属认证组合尚未使用真实云账号测试。
- **不会在后台偷偷调用。** 只有 Agent 调用工具时才会请求图片 API。
