# God agent

Adds a `god` agent. When `god` handles a request, its system prompt is replaced with the prompt configured for the current model ID. Every other agent keeps its normal system prompt.

The plugin ships no prompt content. You provide the files or URLs.

## Install

Standalone:

```jsonc
// opencode.jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "@max10240/opencode-plugin-god",
      "options": {
        "models": {
          "*": "~/.config/opencode/god/default.md",
          "deepseek-v4.1-flash": "~/.config/opencode/god/deepseek-v4.1-flash.md"
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
            "deepseek-v4.1-flash": "~/.config/opencode/god/deepseek-v4.1-flash.md"
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
| `models` | object | `{}` | Model ID to prompt source mapping |
| `cache` | boolean | `true` | Cache loaded prompts |
| `cacheTtlMs` | number | `60000` | HTTP cache lifetime |
| `timeoutMs` | number | `10000` | HTTP request timeout |

See [config.example.jsonc](https://github.com/Max10240/opencode-plugin-unicorn/blob/main/packages/opencode-plugin-god/config.example.jsonc) for a complete example.

## Model matching

- Keys are matched against the model ID only. The provider is ignored, so the same model served by two providers uses the same prompt.
- An exact model ID wins over the `"*"` fallback.
- Without an exact match or `"*"`, the `god` agent keeps the default system prompt.
- Provider-prefixed keys such as `"openai/model-id"` are ordinary model IDs and do not match `model-id`.

## Prompt sources

- `https://` or `http://` URL
- `file://` URL
- Absolute local path
- `~/` path
- Relative path, resolved against the workspace directory

Local files are revalidated on each request by modification time and size. HTTP responses are cached for `cacheTtlMs`. Set `cache` to `false` to load every request.

If a source cannot be loaded, is not a file, or contains only whitespace, the current system prompt is left unchanged and a warning is logged.

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
