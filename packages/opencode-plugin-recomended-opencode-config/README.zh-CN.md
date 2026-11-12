# @max10240/opencode-plugin-recomended-opencode-config

[English](README.md) | **简体中文**

**从第一天起，就有一套更安全、更一致的 OpenCode 配置。**

刚装好的 OpenCode 是一张白纸。你可以花几周时间自己调全局规则、补 review 和规划命令、慢慢摸索哪些默认值适合自己；也可以直接
继承一套已经沉淀好的基线。

这个插件把一组精选的全局规则和命令合并进你现有的配置。它只补缺失的规则和命令，不覆盖你写的规则或同名命令，并在已经配置
OpenAI 时打开 `store:false`。

它是有明确观点的：推荐内容来自维护这个仓库时使用的同一套规则，而不是通用模板。

## 什么时候需要它

- 你刚开始配置 OpenCode，想要一套合理的护栏，但不想自己写。
- 你希望 Agent 在沟通方式、敏感数据和配置修改上保持一致的习惯。
- 你想要现成的 review、commit、调查、规划和持续工作命令。
- 你用 OpenAI，希望默认不保存请求。
- 你有多台机器，想保持同一套基线。

如果你已经有一套精心调过的全局配置，也不希望别人替你加观点，那可以跳过这个插件。

## 它能给你什么

- **推荐规则。** 在全局 `AGENTS.md` 中增加沟通风格、敏感数据、安全修改配置和本地测试习惯等规则。
- **推荐命令。** 补充 review、commit、查看进度、先调查再动手、规划、持续推进等命令。
- **OpenAI 隐私默认值。** 已配置 OpenAI 时设置 `providers.openai.settings.store:false`，不改变你的模型或 variant 选择。
- **非破坏性合并。** 同名规则保留你的版本，同名命令不覆盖，JSONC 注释和无关设置原样保留。
- **可重复执行。** 反复运行不会不断追加重复内容，也不会无意义地重写文件。
- **不碰凭据。** 不会创建 OpenAI key，也不会把秘密写进规则或命令。

## 快速开始

在 server 配置中加载，并显式启用：

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [{
    "package": "@max10240/opencode-plugin-recomended-opencode-config",
    "options": { "enabled": true }
  }]
}
```

通过 Unicorn 使用时：

```jsonc
{
  "plugins": [{
    "package": "@max10240/opencode-plugin-unicorn",
    "options": {
      "features": { "recommendedOpencodeConfig": true },
      "recommendedOpencodeConfig": { "enabled": true }
    }
  }]
}
```

这个插件默认不启用。如果没写 `enabled`，只有当 server 环境里的 `IS_MAX_SELF` 非空、且不是 `0` 或 `false` 时才会开启。
写 `enabled: false` 可以强制关闭。

## 它会改什么

| 范围 | 行为 |
| --- | --- |
| 全局 `AGENTS.md` | 在最高标题层级新增或复用推荐规则章节，把推荐规则放在下面 |
| 全局命令 | 补充推荐集合中缺失的斜杠命令；同名用户命令优先 |
| OpenAI 设置 | 已配置 OpenAI 时设置 `providers.openai.settings.store:false`；显式模型和 variant 设置保持不变 |
| `opencode.jsonc` | 保留 JSONC 注释和无关字段；只有缺少命令且没有配置文件时才创建 |

全局目录依次遵循 `OPENCODE_CONFIG_DIR`、`$XDG_CONFIG_HOME/opencode`，最后是 `~/.config/opencode`。

## 注意事项

- **关闭不会撤销。** 关掉插件只会停止后续合并，已经写入的规则和设置不会自动删除。
- **你的内容优先。** 同名规则会跳过，同名命令不会被覆盖。
- **失败不会阻塞其他插件。** 无法安全合并时只给出警告，其他 Unicorn 插件照常启动。
- **推荐内容是精选的，不是通用的。** 如果你对 Agent 的行为有强烈偏好，启用前先看看这些规则。
- **不改模型配置。** 插件不会修改上下文限制、分享设置或你选择的模型。
