# 项目规则

## OpenCode 源码参考

开发插件时，如果需要查看 OpenCode 源码以确认 API、运行机制或其他实现细节，请使用 `~/daily/opencode/` 中的代码。

## 插件独立性与 Unicorn 集成

- 所有插件都必须能够独立启用和使用，不能依赖其他插件才能运行, 如果需要和其他插件配合，也要做好其他插件不存在的容错和降级方案。
- 所有插件都要集成到 `plugin-unicorn`（`packages/opencode-plugin-unicorn`），并各自提供一个配置项，以便独立开启或关闭。
- 开关应遵循现有的 `features` 配置模式；关闭某个插件不能影响其他插件。具有 server 和 TUI 入口的插件，两端都应遵循对应开关。

## 工具描述

- 所有插件注册的 tool 描述都必须简洁、直接，只说明用途和必要的使用限制。
- 参数的含义及约束写在对应参数的描述中，避免在工具描述中重复。
- 不包含无关的实现细节、内部 API 或传输流程、开发历史、设计决策，以及开发过程中排除方案的说明。

## 插件版本一致性

- 本仓库所有插件包的版本号必须保持一致，统一升级和发布。
- 新增插件也必须使用其他插件当前的统一版本号，不单独从 `1.0.0` 开始。

## 发布

- 唯一入口：`npm run release -- --release-type=<type> [--version=<spec>]`。
- `--release-type` 必须是 `local-publish`、`local-stage`、`ci-publish`、`ci-stage` 之一，不能省略。
- `--version` 默认 `patch`，也可以是 `minor`、`major` 或具体版本。
- 脚本会校验参数、要求工作区干净、跑完整 check、统一 bump 版本，然后发布或触发 CI。
- 目标版本必须严格大于每个包的 registry latest。
- 不要直接调用 `npm publish`，不要提交 `~/.npmrc` 或任何 npm token。
