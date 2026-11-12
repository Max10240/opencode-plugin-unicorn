# @max10240/opencode-plugin-show-img

[English](README.md) | **简体中文**

**Agent 提到的图片，直接看得到。**

Agent 生成了一张图表、指着一张截图，或者保存了一张示意图。在终端里，这通常只意味着一个文件名，然后你得记着稍后去打开它。
如果想让模型也看图，就得把图片附上，既消耗 token，又让对话里塞满图片数据。

这个插件把图片显示在对话里。模型传一个 server 端路径，你在工具输出下方看到预览，图片本身不会进入模型上下文。

## 什么时候需要它

- Agent 保存了截图、图表、示意图或生成的图片，你想马上确认效果。
- 你在调试视觉输出，不想切到文件管理器。
- 你连接远程 OpenCode server，想在本地直接看预览，不用先拷贝文件。
- 你想用图片预览，但不想打开 OpenCode 的全局图片设置。
- 你想让模型处理图片文件，又不想为来回传输像素付费。

## 它能给你什么

- **内联预览。** 图片显示在对应工具输出下方，跟随对话滚动。
- **点击放大。** 打开大图，按 `Esc` 关闭。
- **不占模型上下文。** 模型只看到路径和确认信息，图片字节留在 server 和 TUI 之间。
- **远程 server 也能用。** TUI 通过 OpenCode 的鉴权通道获取预览，client 和 server 不需要共享文件系统。
- **常见格式都支持。** PNG、JPEG、GIF、WebP，最大 20 MiB。终端不支持时自动退化为彩色字符块。
- **可以单独用，也能配合生图。** 图片生成插件可以自动准备预览，`show_img` 自己也能独立使用。

## 快速开始

在 server 配置中加载：

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["@max10240/opencode-plugin-show-img"]
}
```

连接远程 server 时，也要在 client 的 TUI 配置里加载同一个包，这样 client 才有预览 UI：

```jsonc
{
  "$schema": "https://opencode.ai/v2/cli.json",
  "plugins": ["@max10240/opencode-plugin-show-img"]
}
```

通过 Unicorn 使用时，预览默认开启。可以用 `features.showImg: false` 单独关闭。

## 使用

让 Agent 展示一张图片：

> 把 `/srv/app/screenshots/checkout.png` 这张截图显示出来。

Agent 会调用：

```json
{ "abs_file_path": "/srv/app/screenshots/checkout.png" }
```

路径必须是 server 上的绝对路径。同时启用图片生成时，保存后的图片会自动预览，不需要模型额外调用。

## 注意事项

- **预览是引用，不是副本。** 删除或修改源文件，预览也会随之变化。
- **源文件必须还在。** 插件不会永久保存图片快照。
- **这是 UI 与模型的数据边界，不是安全沙箱。** 它防止图片进入模型上下文，但不会阻止 Agent 用其他工具读取同一个文件。
- **权限仍然生效。** Server 以自己的操作系统权限读取文件。不要对不可信的 Agent 开启这个功能。
- **预览跟随消息。** 折叠或尚未挂载的消息，可能要在重新可见后才显示预览。
- **已在 OpenCode `v2.0.21` 和 `v2.1.0` 验证。** 其他版本尚未确认。
