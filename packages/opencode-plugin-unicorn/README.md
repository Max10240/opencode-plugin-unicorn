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

Unicorn 也集成了 `@max10240/opencode-plugin-image-gen`，默认开启；关闭方式：

```jsonc
{
  "plugins": [
    {
      "package": "@max10240/opencode-plugin-unicorn",
      "options": {
        "features": {
          "imageGen": false,
        },
      },
    },
  ],
}
```

图片工具仍使用原 image-gen 插件的 `image_gen` tool 和 provider/model 配置。
默认图像模型为 `openai/gpt-image-2.5-sunburst`；在 Unicorn 的 `options` 中设置 `"model": "openai/gpt-image-2.5-flare"`
即可覆盖，单次工具参数 `model` 优先于该配置。不会把 session 的语言模型当作默认生图模型。

Unicorn 还集成独立的 `@max10240/opencode-plugin-show-img`：`show_img({ abs_file_path })` 通过 server ID 和
UI 专用 RPC 显示图片，不把图片内容交给模型；无需开启全局图片预览设置。设置
`"features": { "showImg": false }` 可独立关闭，与 `imageGen` 开关无关。远程 client 需要加载 Unicorn 的 TUI 入口。
生图/编辑成功后，image-gen 会在 `show_img` 工具可用时自动准备预览；工具不存在或预览失败时，只返回保存路径，
不影响生图成功，也不会把图片内容加入模型上下文。

Unicorn 的 TUI 入口还集成了 prompt reverse-search，默认开启，默认快捷键是 `ctrl+shift+r`：

```jsonc
// cli.json
{
  "plugins": [
    {
      "package": "@max10240/opencode-plugin-unicorn",
      "options": {
        "features": { "promptSearch": true },
        "keybind": "ctrl+shift+r",
        "maxPrompts": 2000,
      },
    },
  ],
}
```

设置 `"features": { "promptSearch": false }` 可以关闭。搜索索引通过 session metadata 增量刷新，选择结果后会将
原 prompt 插入当前输入框的光标位置，不会自动提交。`maxPrompts` 设置最多缓存的 prompt 数量，默认 2000。

## 测试

`bun test` 使用已安装的 `opencode` 启动真实服务，并通过临时 `OPENCODE_CONFIG_DIR` 和本地 OpenAI-compatible
代理验证上下文限制、`share` 修改以及 compaction 正反用例。可用 `OPENCODE_BIN` 指定测试使用的 OpenCode 可执行文件。

## 发布

当前实现不会执行发布操作，也没有自动发布脚本。`publishConfig.registry` 已明确设置为 npm 默认 registry：
`https://registry.npmjs.org/`。未经明确许可不执行 `npm publish` 或 `bun publish`。
