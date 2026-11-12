# OpenCode Plugins Monorepo

[English](README.md) | **简体中文**

这个仓库使用 Bun workspaces 管理多个 OpenCode 插件。

## Packages

- [`@max10240/opencode-plugin-unicorn`](./packages/opencode-plugin-unicorn/README.zh-CN.md)：聚合下列插件的元插件，发布包名保持不变。
- [`@max10240/opencode-plugin-send-message-across-sessions`](./packages/opencode-plugin-send-message-across-sessions/README.zh-CN.md)：跨 cwd 的 session 消息插件。
- [`@max10240/opencode-plugin-prompt-search`](./packages/opencode-plugin-prompt-search/README.zh-CN.md)：TUI 跨 session prompt reverse-search 插件。
- [`@max10240/opencode-plugin-session-search`](./packages/opencode-plugin-session-search/README.zh-CN.md)：搜索当前 session 的用户/agent 对话，回车自动滚动定位，包含已保存的压缩前历史。
- [`@max10240/opencode-plugin-non-blocking`](./packages/opencode-plugin-non-blocking/README.zh-CN.md)：把长时间运行的 Bash 和 subagent 阻塞工具自动放入后台。
- [`@max10240/opencode-plugin-image-gen`](./packages/opencode-plugin-image-gen/README.zh-CN.md)：通过标准 `/images/*` endpoint 生成或编辑图片。
- [`@max10240/opencode-plugin-notepad`](./packages/opencode-plugin-notepad/README.zh-CN.md)：不打断当前对话，按文件夹或全局记录和管理笔记。
- [`@max10240/opencode-plugin-show-img`](./packages/opencode-plugin-show-img/README.zh-CN.md)：通过 ID 和 UI 专用 RPC 预览 server 图片，不将图片内容加入模型上下文。
- [`@max10240/opencode-plugin-opencode-go-usage`](./packages/opencode-plugin-opencode-go-usage/README.zh-CN.md)：在 TUI 中展示所有已登录账号的 OpenCode Go 5 小时、每周和每月用量。
- [`@max10240/opencode-plugin-sensitive-encrypt`](./packages/opencode-plugin-sensitive-encrypt/README.zh-CN.md)：用配置的公钥加密、私钥解密 `$TMPDIR` 下的敏感文件。
- [`@max10240/opencode-plugin-sensitive-protection`](./packages/opencode-plugin-sensitive-protection/README.zh-CN.md)：登记保护文件，并在读取或工具输出进入模型上下文前阻断或脱敏。
- [`@max10240/opencode-plugin-recomended-opencode-config`](./packages/opencode-plugin-recomended-opencode-config/README.zh-CN.md)：可选补充全局规则和 inline commands，并设置已有 OpenAI 的 `store:false`。

## 开发

```bash
bun install
bun run build
bun run typecheck
bun run check
```

### 测试入口

| 命令 | 使用时机 | 范围 |
| --- | --- | --- |
| `bun run check:quick` | 本地快速迭代 | 构建、类型检查、单元/渲染测试；不跑 E2E 和打包验证 |
| `bun run check` | 推送或创建 PR 前 | 全部单元、渲染、E2E 和打包验证；构建/类型检查/打包产物可复用 |
| `bun run check:release` | 发布前 | 与 `check` 相同的完整套件，但不复用缓存，阶段串行执行 |
| `bun run test` | 只调试源码测试 | 单元、渲染和源码 E2E；不做类型检查和打包验证 |
| `bun run test:unit` | 只跑单元/渲染 | 单元测试和 headless TUI 渲染；不构建、不启动 OpenCode |
| `bun run test:e2e` | 只跑 E2E | 构建一次、源码 server/TUI E2E |
| `bun run test:packaged` | 只调试 tarball | Tarball 结构、manifest、exports 和文件列表验证 |

命名规则：

- `check` 是日常完整检查。
- `check:quick` 有意不覆盖全部测试，不能作为发布门槛。
- `check:release` 是无缓存发布门槛；发布流程直接调用它。
- `test*` 是测试子集，不是完整检查。

`bun run check` 每次都会执行全部测试文件，测试结果不会跨运行复用。只有构建产物、类型检查结果和打包 tarball
会按内容哈希在输入未变化时复用。`check:release` 绕过全部缓存并运行同一套完整测试，因此发布前总会检查跨插件回归。
任何检查或发布阶段都不运行 `npm install`。

工作区产物只统一构建一次、每包统一打包一次，按 workspace 依赖顺序构建。不同测试文件使用独立的 root、server、
数据库、HOME 和 tmux socket；只有 warm TUI 文件会有意复用一个预热的 server/TUI 来顺序执行交互测试。
构建和归档的内容哈希不匹配时会失败，不会使用过期产物。E2E 使用加权调度：预热 TUI 通过快速交互测试覆盖真实
tmux；render 测试在进程内覆盖插件 UI 行为；headless server 测试覆盖 API 和消息投递语义。长场景不再为每个
断言冷启动 tmux。每阶段输出实际耗时。

安装包验证只执行 `npm pack` 并检查 tarball 的文件列表、manifest 版本、exports 和预期 dist 文件；
不会创建消费者 `node_modules`，也不会运行 `npm install`。`check` 和 `check:release` 每次都会运行该验证；
打包归档可复用，但验证测试始终执行。

内容寻址检查缓存包含外部依赖声明、Node/npm/Bun 版本、平台和架构；本地包版本和代码字节不作为解析身份，
本地源码和构建哈希决定是否重跑。默认缓存目录为系统临时目录下的 `opencode/unicorn-test-cache`，
可用 `UNICORN_TEST_CACHE_DIR` 指定可写目录并在 CI 中缓存。需要无缓存全量验证时使用 `check:release`。
检查流程不读取用户 npm 认证配置或预加载脚本。
