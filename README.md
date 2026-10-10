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

发布时所有 package 都从 NodeNext 源码编译到被 Git 忽略的 `dist/`。npm tarball 仅包含 `package.json`、`README.md` 和 `dist/**/*.js`，不会发布 `.ts`、`.tsx` 或声明文件。`bun run check` 除了工作区测试，还会真实打包、安装所有包，并分别在隔离的 OpenCode 服务中验证插件；TUI 插件会用 tmux 检查搜索框的交互及响应式过滤，以及 show-img 的跨文件系统图片预览。发布脚本会在改版本号、上传前执行完整检查。
