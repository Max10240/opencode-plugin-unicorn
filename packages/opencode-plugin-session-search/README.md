# @max10240/opencode-plugin-session-search

搜索当前 session 的用户、agent 文字正文，回车后自动滚动到对应消息/文字段落。不会插入、提交或重发 prompt。

## 使用

在全局 `cli.json` 中加载，可独立连接本地或远程 server：

```jsonc
{
  "plugins": [{ "package": "@max10240/opencode-plugin-session-search", "options": { "keybind": "ctrl+shift+f" } }]
}
```

默认快捷键 `Ctrl+Shift+F`，也可从命令面板选择 **Search current session**。
输入过滤，↑/↓ 选择，Enter 跳转，Esc 关闭；加载跳转期间可按 Esc 取消。
匹配不区分大小写，空白分隔的词按 AND 匹配。最多展示 100 条匹配，可继续缩小查询。

Unicorn 默认启用，可用 `features.sessionSearch:false` 独立关闭；通过 `options.sessionSearch.keybind` 设置快捷键，
对应对象直接作为插件 options 传入，不会与 `options.promptSearch.keybind` 混用。server 入口无副作用，不要求加载 prompt-search。

## 历史、压缩与隐私

- 按页读取当前 session 的全部保存历史，不以最近加载的消息或模型 context 为搜索范围。
- 已验证真实压缩后的原始用户/agent 消息仍可搜索和定位；“before compaction”表示消息早于最近压缩。
  压缩摘要不冒充原始对话，隐藏思考、工具输出及附件字节不建立文本索引。
- 撤回边界之后的匹配标记为不可定位，不会为了跳转自动取消撤回或修改会话。
- 尚未投递的排队 prompt 标记为不可定位，不会因选择搜索结果而自动发送。
- 服务端已删除的原文无法恢复。切换 session、关闭 TUI 或禁用插件会取消相关任务；索引仅驻留内存，不写入持久存储。

## 性能与兼容性

首次打开分页索引，最多两个请求并行；不在每次输入时请求历史。未变化的完整索引可复用，
流式更新合并当前消息，查询分批执行并取消过时结果。超长文字不截断索引，预览和结果数量有上限。

已挂载的目标清理宿主导航游标后定位，无需全量加载；较早消息通过内置历史导航加载、挂载后定位。宿主没有公开按 messageID 跳转的专用 API，
插件使用 renderer 消息锚点与内置导航，未修改 Core。宿主首次定位远处消息可能需要 O(N) 加载/挂载，
超长会话不承诺恒定延迟。定位到消息/文字段落起点，不保证长 Markdown 段落内的精确匹配字符行。
缺少导航能力、消息消失或会话切换时会取消/提示，不恢复或改写历史。

已通过 OpenCode `v2.0.21`、`v2.1.0` 的真实 TUI 与 npm 安装包验证；其他版本尚未验证。

前置证据与真实 TUI 验证见仓库 `research/session-search-feasibility.md`。
