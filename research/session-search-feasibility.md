# 当前会话搜索与滚动定位：可行性证据

日期：2026-10-20。实测 OpenCode v2.0.21、v2.1.0，插件 SDK 2.0.10，全部模型请求使用 localhost mock。
参考源码为 `~/daily/opencode` 的 `0e12e2e7`；引用文件无工作区修改，源码与安装 binary 分别验证。

## 结论

可在插件侧实现，无需修改 Core。没有公开的 `ui.session.scrollToMessage` 专用 API，不能仅靠消息列表推断像素位置。
实现使用公开 keymap dispatch、renderer 树和 ScrollBox API；消息锚点命名属于宿主约定，由真实 TUI 回归验证。

| 证据 | 内容 |
| --- | --- |
| V2 CLI 插件文档 | `https://opencode.ai/v2/docs/build/plugins/cli` 提供 renderer、keymap dispatch、会话数据与 dialog；未声明专用消息跳转接口。 |
| SDK 类型 | `@opencode/plugin/dist/tui/context.d.ts` 的 UI 包含 dialog/router/tabs/slot 等；公开 renderer 可找到 renderable。 |
| 内置导航与加载 | `packages/tui/src/routes/session/index.tsx:413-505,829-894` 为尾部挂载、历史分页及 First message 的实现；未挂载消息不能直接滚动定位。 |
| 消息锚点 | `packages/tui/src/routes/session/rows.ts:494-529`：边界行使用 messageID，后续段落使用 `session-part:<messageID>:<partID>`。 |
| 宿主布局等待 | `packages/tui/src/routes/session/index.tsx:393-400,700-749` 需要布局完成后再定位；插件实测使用 renderer 的 frame 事件，不能假定插件沙箱存在全局 requestAnimationFrame。 |
| 全部保存历史分页 | `packages/protocol/src/groups/message.ts:8-40,68-85` 支持类型过滤、每页最多 200 条及不透明 cursor；不是模型 context API。 |
| 压缩后的显示 | `packages/tui/src/routes/session/rows.ts:343-410` 投影保留历史用户/agent 消息，压缩控制消息不替代原文。 |

## 前置实验

真实 TUI 导入 150 轮用户/agent 对话（450 条记录），初始仅挂载尾部 13 个消息锚点。
目标是原本未加载的第 40 轮 agent 消息：内置历史导航准备后，ScrollBox 从尾部滚动位置 106 定位到 810，
目标 `y=1`、viewport `y=1`，屏幕顶部显示目标原文。

随后通过真实 `/compact` 运行压缩，export 仍包含目标原文；452 条记录下再次定位成功，目标仍位于视口顶部。
这证明“只查模型 context”会遗漏历史，但读取保存的消息后可以定位压缩前的原文。

## 实现与验证

- 独立包 `packages/opencode-plugin-session-search`；Unicorn 用 `features.sessionSearch` 独立控制，快捷键单独配置。
- 首次按类型分页读取，最多两个并发请求，页内丢弃工具/附件等非对话索引数据；查询不发历史请求。
- 一个 session 的内存缓存，查询分批让出执行权，取消过时查询；不把完整对话复制到持久化插件存储。
- 已挂载目标清除旧导航游标后定位。未加载目标复用 `session.first`，未挂载目标复用 `session.message.next`，再清除内置导航游标并定位。
- 宿主首次远距离跳转可能 O(N) 加载/挂载；没有专用窗口定位 API，不能承诺超长会话恒定延迟。
- 定位到消息/文字段落起点，不保证单个长 Markdown 段落内的精确字符行。
- 会话切换、撤回、删除、插件卸载和取消任务不能把旧异步结果发布到另一 session。缺失能力或锚点会提示，不伪造成功。

正式 E2E：`packages/opencode-plugin-session-search/test/e2e.test.ts`，独立/Unicorn 各验证启用和关闭。
启用用例导入 260 轮对话（超过每种类型一页），运行真实压缩，搜索用户与 agent 原文，选择第 12 个屏幕外结果、
第二个 agent 文字段落，回车后检查真实 TUI 的目标文字，保持 composer 草稿且不增加模型请求。
还覆盖切换 session 的索引隔离、搜索打开时的新回复、暂存撤回阻止跳转、提交撤回清除旧匹配。
Unicorn 同时启用 prompt-search 和图片预览；验证两种搜索快捷键互不干扰、禁用 session-search 不影响 prompt 插入。
搜索跳转后验证内置上一条/下一条用户消息、回到底部及新回复自动跟随；热关闭插件时移除自己的弹窗，不关闭替代弹窗。
压缩摘要 delta 不触发对话索引重建，仅在压缩完成后刷新标记。
安装包 E2E 对真实 npm 归档中的独立插件和 Unicorn 再做 UI 验证。

旧版连续跳转曾出现有效锚点存在但 frame 等待超时。修复为在新的事件循环任务中请求下一帧，
避免在上一帧调度清理前重复请求；取消/超时仍清理 listener 和定时器。模拟调度回归与两版真实 TUI 均覆盖此行为。

```sh
bun run build
bun test packages/opencode-plugin-session-search/test/e2e.test.ts
bun run check
```

最终复核验证：

| OpenCode | 命令 | 结果 |
| --- | --- | --- |
| v2.1.0 | `bun run check:fresh` | 267 项通过、0 失败 |
| v2.0.21（隔离 binary） | `OPENCODE_BIN=<v2.0.21 binary> bun run check` | 267 项通过、0 失败 |

两轮均包含七包构建/类型检查、单元/headless、真实 server/TUI E2E、七包 npm 归档干净安装及 UI 验证。
未调用收费模型，未修改 Core、全局配置或运行中的共享服务；其他 OpenCode 版本尚未验证。

已删除且服务端不再返回的消息无法恢复；无正文附件、工具输出、隐藏思考与压缩摘要不冒充用户/agent 原文。
