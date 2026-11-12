# @max10240/opencode-plugin-opencode-go-usage

展示当前 server 上**所有已登录 OpenCode Console 账号**的 OpenCode Go 用量。

## 使用

安装插件后，在 TUI 输入：

```text
/usage-opencode-go
```

弹窗会为每个账号显示：

- 5 小时额度（`rolling`）
- 每周额度
- 每月总额度

每个窗口显示已用百分比、进度条和重置时间。当前 active 账号会标记并排在最前。

默认只有在当前 OpenCode server 存在 `opencode` credential 时才启用命令。通过 `/connect` 添加账号后无需重启
即可出现；删除最后一个账号后命令会自动隐藏。

## 配置

```jsonc
{
  "plugins": [{
    "package": "@max10240/opencode-plugin-opencode-go-usage",
    "options": {
      "enabled": "auto",
      "keybind": false
    }
  }]
}
```

| 选项 | 默认值 | 说明 |
| --- | --- | --- |
| `enabled` | `"auto"` | `"auto"` 表示有 OpenCode Console credential 时启用；`true` 始终启用；`false` 完全关闭。 |
| `keybind` | `false` | 可选快捷键。默认不绑定快捷键。 |

独立插件也支持 `features.opencodeGoUsage: false`。通过 Unicorn 使用时请设置
`features.opencodeGoUsage: false`。

## 账号与隐私

OpenCode 将凭据保存在 server 的 SQLite 数据库中。同一个 server 可以同时保存多个 OpenCode Console 账号，
只有一个是 active。本插件会读取全部账号，并分别查询每个账号的 Go 额度。

- token 只保留在 server 插件中；TUI 只接收账号名、workspace、百分比和重置时间。
- 过期的 OAuth 凭据会通过 OpenCode 的 credential API 自动刷新。
- `auth.json` 只是旧版导入来源，插件不会直接读取。请在同一个 server 中通过 `/connect` 添加账号。
- 单个账号不可用不会影响其他账号的展示。

## 范围

本插件只展示 Go 额度，不展示 OpenCode Console 的美元预算或模型预算；这些请使用内置 `/usage`。
Go 用量接口是 OpenCode 的内部接口，未来可能变化。
