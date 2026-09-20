# @max10240/opencode-plugin-unicorn

个人 OpenCode 插件。每个功能都通过插件 options 独立开关；目前只有全局配置同步功能。

## 使用

在全局 `opencode.jsonc` 中配置：

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "@max10240/opencode-plugin-unicorn",
      "options": {
        "features": {
          "globalConfig": true,
        },
      },
    },
  ],
}
```

开启后，插件会幂等地更新全局 `opencode.json` 或 `opencode.jsonc`：

- 确保 `providers.openai.models.gpt-5.6-luna.limit` 为 `context: 1000000`、`input: 922000`、`output: 128000`；
- 缺少顶层 `share` 时写入 `"share": "disabled"`；已有 `share` 值不会覆盖；
- 使用 JSONC 增量编辑，保留无关配置和注释。

`globalConfig: true` 作为 `features.globalConfig` 的兼容写法也支持。所有功能默认开启；要关闭本功能可设置
`"globalConfig": false` 或 `"features": { "globalConfig": false }`。

同时，Unicorn 集成了 `send-message-across-sessions` 功能。可单独关闭：

```jsonc
{
  "plugins": [
    {
      "package": "@max10240/opencode-plugin-unicorn",
      "options": {
        "features": {
          "sendMessageAcrossSessions": false,
        },
      },
    },
  ],
}
```

## 测试

`bun test` 使用已安装的 `opencode` 启动真实服务，并通过临时 `OPENCODE_CONFIG_DIR` 和本地 OpenAI-compatible
代理验证上下文限制、`share` 修改以及 compaction 正反用例。可用 `OPENCODE_BIN` 指定测试使用的 OpenCode 可执行文件。

## 发布

当前实现不会执行发布操作，也没有自动发布脚本。`publishConfig.registry` 已明确设置为 npm 默认 registry：
`https://registry.npmjs.org/`。未经明确许可不执行 `npm publish` 或 `bun publish`。
