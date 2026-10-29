# @max10240/opencode-plugin-image-gen

**English** | [简体中文](README.zh-CN.md)

Generate or edit one image with the target provider's authentication and deployment settings, then save it to a
file. Existing files are never overwritten; names such as `-v2` are allocated automatically. The plugin works
standalone, never reads or guesses credential files, and never returns image bytes to the model conversation.

## Usage

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [{
    "package": "@max10240/opencode-plugin-image-gen",
    "options": { "model": "gateway/gpt-image-2.5-sunburst" }
  }],
  "providers": {
    "gateway": {
      "package": "@opencode/ai/providers/openai-compatible",
      "settings": { "baseURL": "https://gateway.example/v1" },
      "headers": { "Authorization": "{env:GATEWAY_AUTH}" }
    }
  }
}
```

```json
{ "prompt": "A red kite", "out": "kite.png" }
```

Add `images` to edit existing images; paths are relative to the current session directory. Without `images` the tool
generates a new image. The optional `model`, `quality`, `size`, and `images` fields accept `null`, which behaves the
same as omitting them and is removed before calling the image API. The required `prompt` and `out` fields still
accept only strings.

An OpenAI-compatible endpoint must support `/images/generations` and `/images/edits`; chat support does not imply
image support. Base64, image URLs, and data URLs are accepted. URL downloads do not reuse generation auth headers and
do not trigger a second generation. Optional metadata fields in OpenAI-compatible responses may be `null`; parsing
still validates field types and rejects corrupt base64, empty content, and HTTP errors without retrying generation.
Concurrent saves to the same path allocate versioned names with exclusive creation.

## Models and configuration

Priority: tool `model` parameter → plugin `options.model` → `openai/gpt-image-2.5-sunburst`. The default provider is
OpenAI and does not follow the session model automatically. Other providers should use a full `provider/model`.

- Image models that are absent from the language-model catalog are supported and inherit the target provider's
  configuration.
- `provider/model#variant` is supported. When the provider matches the current session model, an omitted variant
  inherits the session choice; `#default` uses the base configuration. Unknown variants fail explicitly.
- Provider/model/variant settings, headers, and body are merged the same way Core merges them; header names are
  case-insensitive.
- Prefer provider settings for custom URLs; `options.baseURL` is an explicit override. Unresolved `${NAME}`
  placeholders reject the request instead of being sent literally.
- GPT Image 2.5 Sunburst, Flare, and explicit snapshots are supported. `quality` accepts
  `low/medium/high/xhigh/max/auto`; `xhigh/max` require model support. The default model is verified at maintenance
  time and is not upgraded over the network.

## Authentication

- Uses Core `integration.connection.active/resolve` to select the active connection, including provider-declared
  environment variables, stored keys/OAuth, and refresh flows. Credential failures propagate; the plugin does not
  silently switch credentials or endpoints.
- Without an active connection, `settings.apiKey`, configured auth headers, and explicitly enabled anonymous
  deployments still work.
- A selected credential takes priority over a configured key. Key configuration is preserved; key metadata may be
  merged into the body, while OAuth metadata is not.
- Authentication and HTTP context are prepared through the native provider model factory before the image protocol
  is used. Organization/project and query mappings are preserved, not every credential is rewritten as a Bearer
  token, and custom providers never fall back to an OpenAI key from the environment.
- Native OpenAI, OpenAI-compatible, Google, xAI, Meta, and ZAI image adapters are supported, along with custom native
  factories that expose `configure().image()`. Known AISDK package names map to native implementations; other
  packages fail explicitly rather than guessing OpenAI from a base URL. Custom packages must be loadable by the
  plugin or use a file URL.

### Known limitations

The public plugin API cannot trigger other plugins' session `model.request`, `http.request`, or `http.response`
hooks. **Signatures, routes, or other authentication provided only by those hooks are not inherited.** Core was not
modified, and this plugin does not claim support for those deployments. `Auth.Definition` values produced by native
provider factories are applied to new image URLs and bodies; synthetic dynamic signatures are covered by tests.

When the runtime provides a tool `signal`, cancellation aborts generation and image download. Older Promise tool
runtimes without a signal cannot guarantee remote cancellation.

ADC/AWS/Azure and other authentication combinations have not been validated with real cloud accounts. A package
without an image adapter is rejected instead of using an incompatible protocol. OpenAI subscription routing reuses
Core-resolved provider URLs and headers; image permission is decided by the service.

## Optional preview and Unicorn

When `show_img` is available, a saved image is passed to it for preview and only an ID/filename is stored in tool
metadata; no extra model call is required. A missing, disabled, or failing preview never affects the generated image,
retries generation, or deletes the output. The plugin still saves images when loaded alone.

Unicorn controls generation and preview with `features.imageGen` and `features.showImg`. Generation options live in
`options.imageGen`, for example `options.imageGen.model` and `options.imageGen.baseURL`; the object is passed to the
standalone plugin unchanged.

## Verification

```sh
bun run --cwd packages/opencode-plugin-image-gen build
bun run --cwd packages/opencode-plugin-image-gen test
bun run check
node research/run-image-gen-auth-parity.mjs
```

Tests use local mocks and never call paid models. Coverage includes auth capture, variants, generation/editing,
error propagation without fallback, custom factory signatures, optional previews, real npm installation, and Unicorn
integration. Evidence and status are documented in
[`research/image-gen-auth-parity.md`](../../research/image-gen-auth-parity.md).
The plugin currently uses `@opencode/ai >=2.2.0` and has been fully regressed against OpenCode `v2.0.21` and `v2.1.0`.

Model discovery references: [models.dev](https://models.dev/api.json),
[OpenAI models API](https://developers.openai.com/api/reference/resources/models/methods/list), and
[OpenRouter](https://openrouter.ai/api/v1/models). Listings can lag or describe third-party routes only; do not
switch the default model by date alone. Verify image output, protocol, account permissions, and parameter support.
