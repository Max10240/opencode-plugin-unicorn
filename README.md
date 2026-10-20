# OpenCode Plugins Monorepo

这个仓库使用 Bun workspaces 管理多个 OpenCode 插件。

## Packages

- [`@max10240/opencode-plugin-unicorn`](./packages/opencode-plugin-unicorn)：个人 OpenCode 插件，发布包名保持不变。
- [`@max10240/opencode-plugin-send-message-across-sessions`](./packages/opencode-plugin-send-message-across-sessions)：跨 cwd 的 session 消息插件。
- [`@max10240/opencode-plugin-prompt-search`](./packages/opencode-plugin-prompt-search)：TUI 跨 session prompt reverse-search 插件。
- [`@max10240/opencode-plugin-image-gen`](./packages/opencode-plugin-image-gen)：基于标准 `/images/*` endpoint 的 V2 生图可行性验证 PoC。
- [`@max10240/opencode-plugin-show-img`](./packages/opencode-plugin-show-img)：通过 ID 和 UI 专用 RPC 预览 server 图片，不将图片内容加入模型上下文。
- [`@max10240/opencode-plugin-recomended-opencode-config`](./packages/opencode-plugin-recomended-opencode-config)：可选补充全局规则和 inline commands，并设置已有 OpenAI 的 `store:false`。

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
| `bun run check:fast` | 构建一次、六包类型检查、单元/渲染测试；不联网安装依赖 |
| `bun run test:e2e` | 构建一次、源码 server/TUI E2E |
| `bun run test` | 单元、渲染和源码 E2E，不包含安装包验证 |
| `bun run test:packaged` | 本轮 npm 归档的全新安装及 server/TUI 验证 |
| `bun run check` / `check:full` | 完整检查，保留全部测试 |
| `bun run check:fresh` | 完整检查，强制重新解析安装依赖；发布前使用 |
| `bun run test:packaged:fresh` | 仅运行强制重新解析依赖的安装包验证 |

工作区产物只统一构建一次、每包统一打包一次，按 workspace 依赖顺序构建。源码和安装包用例使用归档的独立副本，
不复用测试结果、server、数据库、HOME 或 TUI 状态。构建和归档的内容哈希不匹配时会失败，不会使用过期产物。
构建/类型检查最多两个任务并行，E2E 最多三个；每阶段输出实际耗时。

安装包测试每次创建干净的 `node_modules`。首次解析依赖后缓存锁文件和 npm 下载内容；命中后执行真正的
`npm ci --offline`，并用本轮归档更新本地插件的完整性校验，因此同版本代码变化也会被测试。
缓存损坏或离线依赖缺失会清理部分安装并重新安装；安装失败仍会使测试失败。

缓存键包含插件 manifests、Node/npm/Bun 版本、平台及架构。默认目录为系统临时目录下的
`opencode/unicorn-test-cache`，可用 `UNICORN_TEST_CACHE_DIR` 指定可写目录并在 CI 中缓存。
需要检查依赖范围内的新版本时运行 `check:fresh`；该入口不使用缓存锁，但仍可利用 npm 下载缓存。
安装器使用独立 npm 配置，保留网络代理/CA 设置，不读取用户的 npm 认证配置或预加载脚本。

正式 `npm pack` / `npm publish` 的 prepack 构建和规则同步保持不变；只有验证了本轮构建的测试打包才跳过重复生命周期脚本。

也可以只运行指定 workspace：

```bash
bun run --cwd packages/opencode-plugin-unicorn test
bun run --cwd packages/opencode-plugin-unicorn typecheck
```

workspace 配置位于根目录 `package.json` 的 `workspaces` 字段。每个 package 保留自己的入口、依赖、测试和发布配置。

所有插件包使用同一个版本号，新增插件也与 Unicorn 当前版本对齐。`bun run check:versions` 可单独检查；
构建和完整检查会自动校验，版本不一致时立即失败。

推荐规则模板使用全局 `AGENTS.md` 的硬链接。`bun install` 安装 pre-commit hook，commit 和 prepack 前重新同步；
`bun run sync:rules` 可手动同步。已有 Git hook 不会被覆盖。commands 只提取全局 JSONC 的对应字段，不收录完整配置。

发布时所有 package 都从 NodeNext 源码编译到被 Git 忽略的 `dist/`。npm tarball 仅包含 `package.json`、`README.md` 和 `dist/**/*.js`，不会发布 `.ts`、`.tsx` 或声明文件。完整检查会真实打包、安装所有包，并分别在隔离的 OpenCode 服务中验证插件；TUI 插件会用独立 tmux socket 检查交互、响应式过滤和跨文件系统图片预览。发布脚本会在改版本号、上传前执行 `check:fresh`。
