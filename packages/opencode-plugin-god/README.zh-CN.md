# God agent

新增一个名为 `god` 的 agent。只有使用 `god` 时，才会按当前 model ID 替换 system prompt；其他 agent 不受影响。

插件本身不包含任何提示词内容，文件或 URL 由你提供。

## 安装

单独使用：

```jsonc
// opencode.jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "@max10240/opencode-plugin-god",
      "options": {
        "models": {
          "*": "~/.config/opencode/god/default.md",
          "deepseek-v4.1-flash": "~/.config/opencode/god/deepseek-v4.1-flash.md"
        }
      }
    }
  ]
}
```

通过 Unicorn 使用：

```jsonc
{
  "plugins": [
    {
      "package": "@max10240/opencode-plugin-unicorn",
      "options": {
        "features": { "god": true },
        "god": {
          "models": {
            "deepseek-v4.1-flash": "~/.config/opencode/god/deepseek-v4.1-flash.md"
          }
        }
      }
    }
  ]
}
```

使用 Unicorn 时，通过 `features.god: true` 或提供 `god` 配置对象来启用；`features.god: false` 会关闭。

## 选项

| 选项 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `models` | object | `{}` | model ID 到提示词来源的映射 |
| `cache` | boolean | `true` | 是否缓存已加载的提示词 |
| `cacheTtlMs` | number | `60000` | HTTP 缓存时间 |
| `timeoutMs` | number | `10000` | HTTP 请求超时 |

完整示例见 [config.example.jsonc](https://github.com/Max10240/opencode-plugin-unicorn/blob/main/packages/opencode-plugin-god/config.example.jsonc)。

## 模型匹配

- 只按 model ID 匹配，provider 不参与，因此同一模型由不同 provider 提供时使用同一个提示词。
- 精确 model ID 优先于 `"*"` 回退项。
- 没有精确匹配也没有 `"*"` 时，`god` 保持默认 system prompt。
- `"openai/model-id"` 这类 provider 前缀只是普通 model ID，不会匹配 `model-id`。

## 提示词来源

- `https://` 或 `http://` URL
- `file://` URL
- 绝对路径
- `~/` 路径
- 相对路径，以工作区目录为基准

本地文件每次请求都会按修改时间和大小重新校验。HTTP 响应在 `cacheTtlMs` 内缓存。将 `cache` 设为 `false` 可每次重新加载。

加载失败、不是文件、或内容只有空白时，保持当前 system prompt 不变，并输出警告。

## 说明

- 需要显式选择 `god` agent；其他 agent 永远不会被修改。
- 插件只读取文本；提示词内容和 provider 条款由你负责。
- 单独插件和 Unicorn 二选一，不要同时启用。

## 开发

```bash
bun test
bun run typecheck
bun run build
```
