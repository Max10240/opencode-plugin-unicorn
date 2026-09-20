# OpenCode Plugins Monorepo

这个仓库使用 Bun workspaces 管理多个 OpenCode 插件。

## Packages

- [`@max10240/opencode-plugin-unicorn`](./packages/opencode-plugin-unicorn)：个人 OpenCode 插件，发布包名保持不变。

## 开发

```bash
bun install
bun run typecheck
bun test
```

也可以只运行指定 workspace：

```bash
bun run --cwd packages/opencode-plugin-unicorn test
bun run --cwd packages/opencode-plugin-unicorn typecheck
```

workspace 配置位于根目录 `package.json` 的 `workspaces` 字段。每个 package 保留自己的入口、依赖、测试和发布配置。
