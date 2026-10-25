# @max10240/opencode-plugin-recomended-opencode-config

独立合并推荐的全局规则和命令，并在已有 OpenAI 配置时设置 `providers.openai.settings.store:false`。
不修改模型限制或 `share`，不注册工具，也不依赖 Unicorn。

## 启用

显式 `enabled:true/false` 优先于环境变量；没有配置时，server 环境的 `IS_MAX_SELF` 必须非空，且不是 `0` 或
`false` 才启用。比较前去掉两端空白，`false` 不区分大小写；其他情况默认关闭。

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [{
    "package": "@max10240/opencode-plugin-recomended-opencode-config",
    "options": { "enabled": true }
  }]
}
```

Unicorn 将 `options.recommendedOpencodeConfig` 原样透传，例如 `{ "enabled": true }`。
`options.features.recommendedOpencodeConfig: false` 强制关闭；其余情况遵循上述 `enabled` / 环境变量规则。
关闭后不撤销已写入的规则或设置。

## 合并行为

- 使用 Marked 解析 Markdown，规则数据为 `{ title, description? }`，不保存标题等级。
- 在用户 `AGENTS.md` 的最高标题等级新增或复用 `Addtional Recommended Rules`，推荐规则放在其下。
- 标题相同即跳过，不比较标题等级，不覆盖已有正文；代码块中的 `#` 不算标题。
- 没有标题时用一级容器。容器已是六级时使用列表承载规则，不生成无效的七级标题。
- 同步维护者的 inline 和 Markdown 命令。同名用户定义（包括全局 Markdown command）不覆盖；缺失时
  新增到用户的 inline `commands`，保留 `template`、描述、agent、model 等元数据和参数占位符。
- 没有 OpenAI key 时不创建它。只有缺少 commands 且无配置文件时才创建 `opencode.jsonc`。
- 保留 JSONC 注释和无关设置，重复运行不改文件时间。provider 设置不覆盖模型或 variant 的显式设置。
- 更新失败只警告，不阻止其他 Unicorn 插件启动。
- 未闭合的代码/HTML 块无法安全合并时跳过规则写入，不反复追加，也不阻止 commands 和 `store` 更新。
  配置使用软链接时更新目标而保留软链接。

全局目录遵循 `OPENCODE_CONFIG_DIR`，其次 `$XDG_CONFIG_HOME/opencode`，默认 `~/.config/opencode`。

## 推荐模板与硬链接

仓库的 `rules/AGENTS.md` 与维护者的 `~/.config/opencode/AGENTS.md` 保持硬链接。
`bun run sync:rules`、Git pre-commit 和每个包的 prepack 都会重新建立链接，并将 `opencode.jsonc` 的顶层 `commands`
和同目录 `.commands/`、`command/`、`commands/` 下的 `.md` 命令收集到 `rules/commands.json`，不保存完整配置。
Markdown 正文作为模板，保留 description、agent、model、subagent 等 frontmatter；嵌套文件 `team/review.md`
变成 `team/review`。同步时不执行模板中的 shell。源内同名命令按 inline → `.commands/` → `command/` → `commands/` 覆盖。
Markdown 中的 `{env:...}`、`{file:...}` 保持字面文本；原有 inline 命令仍遵循 Core 的配置变量展开规则。
可用 `RECOMMENDED_RULES_SOURCE` / `RECOMMENDED_COMMANDS_SOURCE` 指定同步源，`RECOMMENDED_COMMANDS_DIR` 指定单独的 Markdown 目录。
所有同步源均不存在时使用已提交的模板；源存在时会移除源已删除的推荐，解析失败则保留原快照并报错。

Git 保存文件内容而不是链接路径，clone 后需重新建立硬链接。发布包把推荐规则内容编入 JavaScript，不要求用户
拥有维护者的目录，也不收录任何完整 `opencode.json[c]`。不要在规则或命令模板中放凭据。

根目录 `bun install` 为新仓库安装 `.githooks`。已有本地/全局 hooksPath 或 pre-commit 时只提示，不覆盖、不阻止
依赖安装；此时需把 `scripts/sync-recommended-rules.mjs` 接入已有 hook，或提交前手动执行 `bun run sync:rules`。

## 验证

`bun run check` 包含 Markdown/JSONC 单测、硬链接和 prepack 测试、真实 OpenCode 的开关矩阵、配置热重载、
重启幂等性、模型请求中的规则与 `store:false`，以及 npm tarball 安装。测试使用隔离目录和本地 mock。
