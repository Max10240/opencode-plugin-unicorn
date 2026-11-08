# 测试性能验证

[English](test-performance.md) | **简体中文**

2026-11-08，macOS arm64，8 核测试机，Bun 1.4.4。耗时是测试环境样本，不是跨机器性能保证。

## 当前入口

| 命令 | 使用时机 | 典型耗时 |
| --- | --- | --- |
| `bun run test:unit` | 只跑单元/渲染 | 约 5 s |
| `bun run check:quick` | 本地快速迭代 | 约 7–8 s |
| `bun run check` | 日常完整缓存检查 | 约 19–22 s |
| `bun run check:release` | 发布前完整无缓存检查 | 约 40–42 s |
| `bun run test:packaged` | 只调试 tarball | 约 0.4 s |

`check:quick` 有意不包含 E2E 和打包验证。`check` 与 `check:release` 都会执行全部单元、渲染、E2E 和打包测试；
唯一区别是缓存复用和阶段顺序。测试结果不会跨运行复用。

## 测试分层

- 一个预热 server/TUI 文件覆盖 notepad、prompt search、session search、加密和图片预览的真实终端交互。
  文件约 6.5–7 s，单个测试体约 0.14–0.9 s。
- render 测试在进程内覆盖插件 UI 行为，不启动 server 或 tmux。
- headless server 测试覆盖 session-search 的历史、compaction、revert 和消息投递语义。
  session-search controller E2E 约 0.9 s。
- send-message 不再使用 tmux；使用真实 server 和 `opencode run` 子进程，mode 之间只共享只读的解包目录。

## 缓存范围

只有构建产物、类型检查结果和打包 tarball 按内容哈希复用。测试结果不缓存，也不会因为上次通过而跳过。
`check:release` 绕过全部缓存并串行执行阶段，避免冷缓存争抢。

任何检查或发布阶段都不运行 `npm install`。打包验证只执行 `npm pack` 并检查生成的 tarball。

## 波动

测试机同时运行其他应用，因此 `check` 耗时会波动。空闲时可到 18.6–19.5 s；负载较高时为 22–28 s。
无缓存的 `check:release` 因为阶段串行，反而更稳定。
