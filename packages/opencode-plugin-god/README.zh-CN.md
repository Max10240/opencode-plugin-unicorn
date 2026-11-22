# God agent

新增一个名为 `god` 的 agent。只有使用 `god` 时，才会按当前 model ID 替换 system prompt；其他 agent 不受影响。

插件开箱即用：内置一张 model ID 到公开提示词文件的映射表，并提供通配回退。只有想覆盖某个模型或改用自己的文件时，才需要写 `models`。

## 安装

单独使用：

```jsonc
// opencode.jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["@max10240/opencode-plugin-god"]
}
```

这就是全部配置。要覆盖某个模型或回退项：

```jsonc
{
  "plugins": [
    {
      "package": "@max10240/opencode-plugin-god",
      "options": {
        "models": {
          "deepseek-v4.1-flash": "~/.config/opencode/god/deepseek.md",
          "*": "~/.config/opencode/god/default.md"
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
            "deepseek-v4.1-flash": "~/.config/opencode/god/deepseek.md"
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
| `models` | object | `{}` | model ID 到提示词来源的映射，覆盖内置表 |
| `sourceBaseUrl` | string | GitHub raw 基址 | 内置表使用的基址，可指向镜像 |
| `cache` | boolean | `true` | 是否缓存已加载的提示词 |
| `cacheTtlMs` | number | `86400000` | 已缓存提示词超过该时长后在后台刷新 |
| `timeoutMs` | number | `10000` | HTTP 请求超时 |

完整示例见 [config.example.jsonc](https://github.com/Max10240/opencode-plugin-unicorn/blob/main/packages/opencode-plugin-god/config.example.jsonc)。

## 模型匹配

按顺序检查，命中即用：

1. `models["<provider>/<model-id>"]`，仅对该 provider 生效
2. `models["<model-id>"]`
3. `models["*"]`
4. 内置表精确 model ID
5. 去掉 `-free` / `:free` 后缀后的内置 model ID
6. 内置家族前缀，例如 `claude-opus`、`claude-sonnet`
7. 内置通配回退项

用户配置永远优先于内置表。除 provider 前缀键外，匹配都忽略 provider，因此同一模型由不同 provider 提供时使用同一个提示词。由于 `models["*"]` 对所有模型生效，一旦设置它就会取代内置表。

## 提示词来源

- `https://` 或 `http://` URL
- `file://` URL
- 绝对路径
- `~/` 路径
- 相对路径，以工作区目录为基准

## 加载与缓存

- 远程提示词同时缓存在内存与插件存储中，进程重启后不会重新拉取。
- 有缓存时立即返回；缓存超过 `cacheTtlMs` 后在后台刷新，当前请求仍使用已缓存的文本。
- 内置项加载失败时，会先用一次通用兜底提示词，再决定是否放弃。
- 刚刚失败的来源在五分钟内不会重试，因此源站不可用不会给每个请求都加一次超时。
- 加载失败时保留上一次的文本；完全没有可用内容时，模型沿用自身 system prompt，请求继续执行。
- 本地文件每次请求都会按修改时间和大小重新校验。
- 将 `cache` 设为 `false` 可每次重新加载。

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
