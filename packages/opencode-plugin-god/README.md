# God agent

Adds a `god` agent. When `god` handles a request, its system prompt is replaced with the prompt chosen for the current model ID. Every other agent keeps its normal system prompt.

The plugin works without configuration. It ships a table of model IDs that point at published prompt files, plus a wildcard fallback, so installing it is enough to use `god`. Add `models` only to override a model or to point at your own files.

## Install

Standalone:

```jsonc
// opencode.jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["@max10240/opencode-plugin-god"]
}
```

That is the whole configuration. To override a model or the fallback:

```jsonc
{
  "plugins": [
    {
      "package": "@max10240/opencode-plugin-god",
      "options": {
        "models": {
          "deepseek-v4.1-flash": "~/.config/opencode/god/deepseek.md",
          "*": "~/.config/opencode/god/default.md"
        }
      }
    }
  ]
}
```

Through Unicorn:

```jsonc
{
  "plugins": [
    {
      "package": "@max10240/opencode-plugin-unicorn",
      "options": {
        "features": { "god": true },
        "god": {
          "models": {
            "deepseek-v4.1-flash": "~/.config/opencode/god/deepseek.md"
          }
        }
      }
    }
  ]
}
```

Enable it with `features.god: true` or by providing a `god` options object. `features.god: false` disables it.

## Options

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `models` | object | `{}` | Model ID to prompt source mapping. Overrides the built-in table |
| `sourceBaseUrl` | string | GitHub raw base | Base URL for built-in entries, for a mirror |
| `cache` | boolean | `true` | Cache loaded prompts |
| `cacheTtlMs` | number | `86400000` | Age at which a stored prompt is refreshed in the background |
| `timeoutMs` | number | `10000` | HTTP request timeout |

See [config.example.jsonc](https://github.com/Max10240/opencode-plugin-unicorn/blob/main/packages/opencode-plugin-god/config.example.jsonc) for a complete example.

## Model matching

Checked in order, first hit wins:

1. `models["<provider>/<model-id>"]` for the provider serving the request
2. `models["<model-id>"]`
3. `models["*"]`
4. Built-in exact model ID
5. Built-in model ID without a `-free` or `:free` suffix
6. Built-in family prefix, such as `claude-opus` or `claude-sonnet`
7. Built-in wildcard fallback

User entries always win over the built-in table. A provider-qualified key only matches that provider; all other entries ignore the provider, so one model served by two providers uses one prompt. Because `models["*"]` applies to every model, setting it replaces the built-in table for all of them.

## Prompt sources

- `https://` or `http://` URL
- `file://` URL
- Absolute local path
- `~/` path
- Relative path, resolved against the workspace directory

## Loading and caching

- Remote prompts are cached in memory and in plugin storage, so a restart does not refetch them.
- A stored prompt is served immediately. Once it is older than `cacheTtlMs`, it is refreshed in the background; the current request keeps the stored text.
- When a built-in entry cannot be loaded, the shared fallback prompt is used once before giving up.
- A source that just failed is not retried for five minutes, so an unreachable host never adds a timeout to every request.
- A failed load keeps the last stored text. When nothing is available, the model keeps its own system prompt and the request continues.
- Local files are revalidated on each request by modification time and size.
- Set `cache` to `false` to load every request.

## Notes

- Select the `god` agent explicitly; other agents are never modified.
- The plugin only reads text. Prompt content and provider terms are your responsibility.
- Use either the standalone plugin or Unicorn, not both at the same time.

## Development

```bash
bun test
bun run typecheck
bun run build
```
