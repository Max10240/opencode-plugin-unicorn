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
        "sessionSearch": true,
        "recommendedOpencodeConfig": false
      },
      "imageGen": { "model": "openai/gpt-image-2.5-sunburst" },
      "sendMessageAcrossSessions": {},
      "showImg": {}
    }
  }]
}
```

`features.<名称>: false` 强制关闭对应子插件，不影响其他插件；未设为 `false` 时允许加载。
每个子插件也可独立加载。

## 子插件配置

Unicorn 将同名嵌套对象原样作为该子插件的 `options` 传入，不重命名字段、不混入其他子插件或顶层参数。
未配置时传入空对象，默认值和参数处理由子插件负责。server 和 TUI 使用相同规则。
子插件自身的关闭参数同样生效，例如 `showImg.features.showImg: false`；外层 `features.showImg: false` 始终优先关闭。

| 嵌套对象 | 用途 | 配置位置 |
| --- | --- | --- |
| `recommendedOpencodeConfig` | 推荐规则与命令，如 `enabled` | `opencode.json(c)` |
| `sendMessageAcrossSessions` | 跨 session 消息 | `opencode.json(c)` |
| `imageGen` | 生图，如 `model`、`baseURL`、`integrationID` | `opencode.json(c)` |
| `showImg` | 图片预览 | server 和 client 分别配置 |
| `promptSearch` | prompt 检索，如 `keybind`、`maxPrompts` | `cli.json` |
| `sessionSearch` | 当前对话检索，如 `keybind` | `cli.json` |

`recommendedOpencodeConfig` 对应独立的
[`@max10240/opencode-plugin-recomended-opencode-config`](../opencode-plugin-recomended-opencode-config)。
`features.recommendedOpencodeConfig: false` 强制关闭；否则由 `recommendedOpencodeConfig.enabled` 决定是否启用。
`enabled` 未配置时才读取 server 环境中的 `IS_MAX_SELF`；变量缺失、为空、为 `0` 或 `false` 时关闭。
例如 `"recommendedOpencodeConfig": { "enabled": true }` 显式启用；Unicorn 不会把 feature 开关转换为 `enabled`。
旧 `globalConfig` 开关已移除，Luna 上下文限制和 `share` 不再自动修改。
推荐配置插件也会补充缺失的 inline commands；已有同名用户命令保持原样。

图像模型默认 `openai/gpt-image-2.5-sunburst`。`options.imageGen.model` 可覆盖默认值，单次 `image_gen` 的 `model` 参数
优先级最高。生成/编辑成功后，`show_img` 可用时自动准备 UI 预览；缺失或失败不影响生图，不向模型返回图片内容。

## TUI

远程 client 在 `cli.json` 加载 Unicorn，server-only 插件不在 client 运行：

```json
{
  "plugins": [{
    "package": "@max10240/opencode-plugin-unicorn",
    "options": {
      "features": { "promptSearch": true, "sessionSearch": true, "showImg": true },
      "promptSearch": { "keybind": "ctrl+shift+r", "maxPrompts": 2000 },
      "sessionSearch": { "keybind": "ctrl+shift+f" },
      "showImg": {}
    }
  }]
}
```

历史 prompt 检索默认 `ctrl+shift+r`，最多缓存 2000 条。选择结果插入输入框，不自动提交。
当前 session 检索默认 `ctrl+shift+f`，搜索用户/agent 正文，选择结果滚动定位，不插入输入框。
它按页读取保存的历史，包含压缩前原文；详见独立的 [session-search 插件](../opencode-plugin-session-search)。
图片预览显示在对应工具输出下方，随会话正文滚动；点击放大，Esc 关闭，不依赖全局图片预览开关。

## 从扁平配置迁移

Unicorn 不再读取顶层 `model`、`baseURL`、`integrationID`、`keybind`、`shortcut`、`maxPrompts`、`sessionSearchKeybind`。
生图参数移入 `imageGen`；prompt 检索参数移入 `promptSearch`；`sessionSearchKeybind` 改为 `sessionSearch.keybind`。
原先仅用 `features.recommendedOpencodeConfig: true` 显式启用的配置，需补充 `recommendedOpencodeConfig.enabled: true`。
独立插件的配置格式不变。

## 开发

根目录运行 `bun run check`，使用真实 OpenCode、tmux 和隔离的本地 mock 验证各插件及 npm 安装包。
所有插件版本一致，内部依赖精确固定到同版本，不使用 `^1`，避免 `latest` / `prerelease` 标签不同步时安装旧子包。
统一升版后运行 `bun run sync:versions` 同步内部依赖；`publish:all` 已包含此步骤，不自动创建 Git commit/tag。
升版阶段不重装 workspace 依赖，待版本及内部依赖同步完成后再构建。
可用 `npm run publish:all -- --dry-run` 完整验证并模拟升版，不登录、改实际版本或上传 npm。
`check:fresh` 还会只安装 Unicorn，在 `latest` 指向旧子包的隔离 registry 中验证依赖解析，并运行图片随正文滚动的 tmux E2E。
不会自动执行发布或更新正在运行的插件。
