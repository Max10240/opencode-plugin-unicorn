# @max10240/opencode-plugin-unicorn

Unicorn 只负责独立插件的配置开关、装配和清理，不直接实现工具或修改全局配置。

## 使用

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [{
    "package": "@max10240/opencode-plugin-unicorn",
    "options": {
      "features": {
        "sendMessageAcrossSessions": true,
        "imageGen": true,
        "showImg": true,
        "promptSearch": true,
        "recommendedOpencodeConfig": false
      }
    }
  }]
}
```

前四项默认开启，分别控制跨 session 消息、生图、用户图片预览和历史 prompt 检索。
关闭其中一项不影响其他项，每个子插件也可独立加载。

`recommendedOpencodeConfig` 对应独立的
[`@max10240/opencode-plugin-recomended-opencode-config`](../opencode-plugin-recomended-opencode-config)。
显式 `true/false` 优先；未配置时才读取 server 环境中的 `IS_MAX_SELF`。变量缺失、为空、为 `0` 或 `false` 时关闭。
旧 `globalConfig` 开关已移除，Luna 上下文限制和 `share` 不再自动修改。
推荐配置插件也会补充缺失的 inline commands；已有同名用户命令保持原样。

图像模型默认 `openai/gpt-image-2.5-sunburst`。`options.model` 可覆盖默认值，单次 `image_gen` 的 `model` 参数
优先级最高。生成/编辑成功后，`show_img` 可用时自动准备 UI 预览；缺失或失败不影响生图，不向模型返回图片内容。

## TUI

远程 client 在 `cli.json` 加载 Unicorn，server-only 插件不在 client 运行：

```json
{
  "plugins": [{
    "package": "@max10240/opencode-plugin-unicorn",
    "options": {
      "features": { "promptSearch": true, "showImg": true },
      "keybind": "ctrl+shift+r",
      "maxPrompts": 2000
    }
  }]
}
```

历史 prompt 检索默认 `ctrl+shift+r`，最多缓存 2000 条。选择结果插入输入框，不自动提交。
图片预览显示在输入框上方，点击放大，Esc 关闭；不依赖全局图片预览开关。

## 开发

根目录运行 `bun run check`，使用真实 OpenCode、tmux 和隔离的本地 mock 验证各插件及 npm 安装包。
所有插件版本一致，统一发布到 npm；不会自动执行发布。
