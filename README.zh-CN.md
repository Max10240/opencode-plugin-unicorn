# OpenCode Plugins Monorepo

[English](README.md) | **简体中文**

这个仓库使用 Bun workspaces 管理多个 OpenCode 插件。

## Packages

- [`@max10240/opencode-plugin-unicorn`](./packages/opencode-plugin-unicorn/README.zh-CN.md)：聚合下列插件的元插件，发布包名保持不变。
- [`@max10240/opencode-plugin-send-message-across-sessions`](./packages/opencode-plugin-send-message-across-sessions/README.zh-CN.md)：跨 cwd 的 session 消息插件。
- [`@max10240/opencode-plugin-prompt-search`](./packages/opencode-plugin-prompt-search/README.zh-CN.md)：TUI 跨 session prompt reverse-search 插件。
- [`@max10240/opencode-plugin-session-search`](./packages/opencode-plugin-session-search/README.zh-CN.md)：搜索当前 session 的用户/agent 对话，回车自动滚动定位，包含已保存的压缩前历史。
- [`@max10240/opencode-plugin-image-gen`](./packages/opencode-plugin-image-gen/README.zh-CN.md)：通过标准 `/images/*` endpoint 生成或编辑图片。
- [`@max10240/opencode-plugin-notepad`](./packages/opencode-plugin-notepad/README.zh-CN.md)：不打断当前对话，按文件夹或全局记录和管理笔记。
- [`@max10240/opencode-plugin-show-img`](./packages/opencode-plugin-show-img/README.zh-CN.md)：通过 ID 和 UI 专用 RPC 预览 server 图片，不将图片内容加入模型上下文。
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

| 命令 | 范围 |
| --- | --- |
| `bun run test:unit` | 单元测试和 headless TUI 渲染；不构建、不启动 OpenCode |
| `bun run check:fast` | 构建一次、全部 workspace 类型检查、单元/渲染测试；不联网安装依赖 |
| `bun run test:e2e` | 构建一次、源码 server/TUI E2E |
| `bun run test` | 单元、渲染和源码 E2E，不包含安装包验证 |
| `bun run test:packaged` | 本轮 npm 归档的 tarball 结构、manifest、exports 和文件列表验证；不执行安装 |
| `bun run check` | 增量完整检查；未变化的工作直接复用内容寻址缓存 |
| `bun run check:full` | 运行全部源码测试（含长真实 TUI 场景），复用缓存 |
| `bun run check:fresh` | 完整检查，不复用缓存；发布前使用 |

`bun run check` 会按源码、测试、工具链和环境哈希缓存成功的构建、类型检查、测试文件和打包结果，只重跑受影响的部分。
测试依赖每次从文件的实际本地 import 和包路径引用推导，没有需要手工维护、可能过期的依赖注解。
Unicorn 自身的 E2E 还依赖所有 workspace 包的构建产物，任何子包变化都会重新验证组装后的插件；
其他插件测试只依赖自身包、导入的 helper 和显式引用的包。`check:fresh` 完全绕过缓存并一起运行全部套件，
因此发布前总会检查跨插件回归。发布流程调用 `check:fresh`，然后执行 pack-only 的 tarball 检查；
安装包 tarball 未变化时按包复用，任何流程都不运行 `npm install`。

工作区产物只统一构建一次、每包统一打包一次，按 workspace 依赖顺序构建。源码和安装包用例使用归档的独立副本，
不复用测试结果、server、数据库、HOME 或 TUI 状态。构建和归档的内容哈希不匹配时会失败，不会使用过期产物。
构建、类型检查和单元测试按 CPU 数量并行；E2E 将长 TUI 文件与宽 API 文件分组调度，避免过度并发。每阶段输出实际耗时。

安装包验证只执行 `npm pack` 并检查 tarball 的文件列表、manifest 版本、exports 和预期 dist 文件；
不会创建消费者 `node_modules`，也不会运行 `npm install`。日常检查不运行它；发布流程会显式执行这个 pack-only 检查。

内容寻址检查缓存包含外部依赖声明、Node/npm/Bun 版本、平台和架构；本地包版本和代码字节不作为解析身份，
本地源码和构建哈希决定是否重跑。默认缓存目录为系统临时目录下的 `opencode/unicorn-test-cache`，
可用 `UNICORN_TEST_CACHE_DIR` 指定可写目录并在 CI 中缓存。需要无缓存全量验证时使用 `check:fresh`。
检查流程不读取用户 npm 认证配置或预加载脚本。
