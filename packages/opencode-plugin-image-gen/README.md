# @max10240/opencode-plugin-image-gen

**English** | [简体中文](README.zh-CN.md)

**Generate and edit images without leaving the conversation.**

You are writing a README and need a header image. You are building a UI and want a quick mockup. You have a reference
image and want a variation. The usual workflow means leaving OpenCode, opening an image tool, downloading a file, and
coming back to describe what you got.

With this plugin, you just ask. The agent generates or edits the image, saves it to your project, and—when image preview
is available—shows it in the conversation. Image bytes never enter the model context, so the agent keeps its attention
on the work, not on pixels.

## When to use it

- You need illustrations, icons, mockups, or social media images while writing.
- You want to edit or restyle an existing image by describing the change.
- You want generated assets saved directly into the repository.
- You care about keeping image data out of the model conversation.
- You already use OpenAI or another supported image provider in OpenCode.

## What you get

- **One sentence, one image.** Ask the agent in natural language; it calls the tool for you.
- **Generate or edit.** Omit reference images to create something new; include them to edit.
- **Safe file handling.** Existing files are never overwritten; names such as `-v2` are allocated automatically.
- **Inline preview.** When the preview plugin is available, the image appears below the tool output and can be
  enlarged.
- **Uses your existing provider setup.** The plugin reuses the provider and credentials already configured in OpenCode.
  It does not read credential files or guess keys.
- **No image bytes in chat.** The model receives a confirmation and a file reference, not the image itself.

## Quick start

Load it in the server configuration. The default model is `openai/gpt-image-2.5-sunburst`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [{
    "package": "@max10240/opencode-plugin-image-gen",
    "options": { "model": "openai/gpt-image-2.5-sunburst" }
  }]
}
```

To use a gateway or another provider, configure it in the same file:

```jsonc
{
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

With Unicorn, image generation is enabled by default:

```jsonc
{
  "plugins": [{
    "package": "@max10240/opencode-plugin-unicorn",
    "options": {
      "features": { "imageGen": true, "showImg": true },
      "imageGen": { "model": "openai/gpt-image-2.5-sunburst" }
    }
  }]
}
```

## Using it

Ask naturally:

> Generate a minimal illustration of a paper kite for the README, save it as `docs/kite.png`.

The agent calls `image_gen` with:

```json
{ "prompt": "A red kite", "out": "kite.png" }
```

Add `images` to edit existing images. Paths are relative to the current session directory.

```json
{
  "prompt": "Make the sky warmer and add a small cloud",
  "out": "kite-v2.png",
  "images": ["kite.png"]
}
```

Optional fields: `model`, `quality`, `size`, and `images`. The `prompt` and `out` fields are required.

## Configuration

| Setting | Priority | Notes |
| --- | --- | --- |
| Model | Tool argument → `options.model` → `openai/gpt-image-2.5-sunburst` | Use `provider/model` for non-OpenAI providers |
| Quality | Tool argument | `low`, `medium`, `high`, `xhigh`, `max`, or `auto`; `xhigh` and `max` require model support |
| Size | Tool argument | Depends on what the provider supports |
| Reference images | Tool argument | Relative to the session directory |

The default provider is OpenAI and does not follow your conversation model automatically. If you use another provider,
give it a full `provider/model` name. Your provider's headers, base URL, and variant settings are respected.

## Good to know

- **The provider must support images.** An OpenAI-compatible endpoint must implement `/images/generations` and
  `/images/edits`. Chat support alone is not enough.
- **Generation and preview are separate.** A missing, disabled, or failing preview never affects the generated file and
  never triggers a second generation.
- **Files are references, not chat attachments.** The image lives on disk; the model only gets a path and a preview
  reference.
- **Some advanced authentication may need extra setup.** If a provider depends on another plugin to sign requests or
  inject routes, that behavior is outside this plugin's control.
- **Image permissions are decided by the provider.** A valid credential does not guarantee that the account can use
  image models.
- **Cloud authentication may need extra validation.** Provider-specific combinations such as AWS, Azure, or Google ADC
  have not been tested with real cloud accounts.
- **No paid calls in the background.** The plugin only calls the image API when the agent invokes the tool.
