# @max10240/opencode-plugin-show-img

用 `show_img({ abs_file_path })` 向用户展示 server 上的图片，不把图片内容加入模型上下文。

## 使用

在 OpenCode server 的 `opencode.jsonc` 中加载插件：

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["@max10240/opencode-plugin-show-img"]
}
```

插件自带 `./tui` 入口。本机正常加载时不需要额外打开图片预览设置；连接远程 server 时，也可在 client 的
`cli.json` 中显式加载同一个包，以确保 client 有 TUI 插件：

```json
{
  "$schema": "https://opencode.ai/v2/cli.json",
  "plugins": ["@max10240/opencode-plugin-show-img"]
}
```

模型只需调用：

```json
{ "abs_file_path": "/absolute/path/on/server/image.png" }
```

TUI 在当前 session 的输入框上方显示最近一次预览，点击缩略图或尺寸文字可放大，Esc 关闭。不会修改或读取
`session.image_preview` / `prompt.image_preview`；两项关闭时仍可显示。支持 PNG、JPEG、GIF 和 WebP，最大 20 MiB。
不支持的终端由 OpenTUI 自动退化为彩色字符块。

与 image-gen 同时启用时，image-gen 保存图片后会直接调用 `show_img` 准备预览引用，TUI 也识别 `image_gen`
结果中的预览 metadata，不要求模型额外调用展示工具。没有 image-gen 时，本插件的 `show_img` 仍可独立使用。

## 数据边界

- Tool 输入只有 server 端绝对路径；`content` 只有确认文本，metadata 只有随机 ID 和文件名。
- Server 插件 storage 持久化 ID → session、规范化文件路径、MIME、文件名，不存图片字节。
- TUI 从已完成的 `show_img` 或 `image_gen` 工具 metadata 取得 ID，通过 OpenCode 已鉴权的 UI 专用 RPC 获取图片。
- RPC 仅接受 ID 和 session ID，不接受任意文件路径；未知 ID 或不匹配的 session 被拒绝。
- 图片 base64 只存在于 RPC 网络传输和 client 展示内存中，不写入工具结果、工具参数或 session 对话。
- Client 不打开 server 路径，所以两端无需共享文件系统。API 认证和远程 HTTPS/安全隧道仍需正常配置。
- 这是引用而不是图片快照：原文件删除后预览不可用，原文件更改后可能显示更新后的内容。
- 工具返回“预览已准备”，不声称无 TUI client 的情况下已经显示成功。

这是 UI 与模型数据流的隔离，不是保密沙箱：不会阻止 agent 显式调用 `read`、shell 或其他工具读取同一文件。
文件读取以 server 进程的系统权限执行，不复用内置 `read` 的逐路径 permission 对话；不要把它启用于不可信的 agent。

## Unicorn

Unicorn 默认集成该功能，server 和 TUI 入口均支持独立关闭：

```json
{ "features": { "showImg": false } }
```

## 开发与测试

```sh
bun run build
bun run test
```

测试使用真实 OpenCode、tmux 和本地 mock 模型。macOS 上对 TUI 禁止访问 server 图片目录，验证图片仍能通过 RPC
展示，同时检查持久化对话及下一次模型请求中没有图片内容。不调用真实模型、不改用户全局配置。

测试覆盖：

- `test/server-e2e.test.ts`：真实工具错误路径、四种格式 RPC、非法参数和跨 session 访问拒绝、server 重启、
  symlink 替换、文件类型变更/增长/删除。
- `test/e2e.test.ts`：独立插件和 Unicorn 的开关；真实 tmux 缩略图/放大/Esc/窗口缩放、实时完成、四种格式、
  解码及 RPC 失败恢复、session 切换、client 热重载、server/client 重启，以及 UI 与模型内容隔离。
- `test/tui/preview.test.tsx`：参考 OpenCode 的 `diff-viewer-image.test.tsx`，使用 OpenTUI `testRender` 检查
  实际 `ImageRenderable` 像素尺寸、窄/宽终端、加载态、错误恢复、请求取消和过期响应隔离。
- `test/assets.test.ts` / `test/lifecycle.test.ts`：文件边界、storage 失败与注册清理。
- 根目录 `bun run check` 还会构建、类型检查，并真实打包安装所有 npm 包后重复 TUI E2E。

组件单测通过独立的 browser-condition + Solid preload 进程运行；请用 `bun run test`，不要用裸 `bun test`
绕过该环境设置。跨文件系统的读取隔离使用 macOS `sandbox-exec`；其他平台只验证不同 cwd 与 RPC 传输。
