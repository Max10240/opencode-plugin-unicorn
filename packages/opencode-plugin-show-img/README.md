# @max10240/opencode-plugin-show-img

**English** | [简体中文](README.zh-CN.md)

**See the images your agent is talking about.**

The agent generates a chart, points at a screenshot, or saves a diagram. In a terminal, that usually means a filename
and a mental note to open it later. If you want the model to look at the image, you have to attach it, which spends
tokens and fills the conversation with image data.

This plugin shows the image in the conversation instead. The model passes a server-side path, the user gets an inline
preview below the tool output, and the image never enters model context.

## When to use it

- The agent saves screenshots, charts, diagrams, or generated images and you want to check them immediately.
- You are debugging visual output and do not want to switch to a file manager.
- You use a remote OpenCode server and want previews without copying files to your laptop.
- You want image previews without enabling OpenCode's global image settings.
- You want the model to work with image files without paying to send pixels back and forth.

## What you get

- **Inline previews.** Each image appears below its tool output and scrolls with the conversation.
- **Click to enlarge.** Open a larger view and press `Esc` to close it.
- **No model context cost.** The model sees a path and a confirmation; image bytes stay between the server and the TUI.
- **Works with remote servers.** The TUI fetches the preview through OpenCode's authenticated channel, so the client
  and server do not need a shared filesystem.
- **Four common formats.** PNG, JPEG, GIF, and WebP up to 20 MiB. Unsupported terminals fall back to colored character
  blocks.
- **Works alone or with image generation.** Image-gen can prepare a preview automatically, but `show_img` is useful on
  its own.

## Quick start

Load it in the server configuration:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["@max10240/opencode-plugin-show-img"]
}
```

When connecting to a remote server, also load the same package in the client's TUI configuration so the client has the
preview UI:

```jsonc
{
  "$schema": "https://opencode.ai/v2/cli.json",
  "plugins": ["@max10240/opencode-plugin-show-img"]
}
```

With Unicorn, previews are enabled by default. Disable them independently with `features.showImg: false`.

## Using it

Ask the agent to show an image:

> Show me the screenshot at `/srv/app/screenshots/checkout.png`.

The agent calls:

```json
{ "abs_file_path": "/srv/app/screenshots/checkout.png" }
```

The path must be absolute and on the server. When image generation is also enabled, saved images are previewed
automatically without an extra tool call.

## Good to know

- **Previews are references, not copies.** Deleting or changing the source file changes what the preview shows.
- **The source file must still exist.** The plugin does not keep a permanent snapshot.
- **This is a UI boundary, not a security sandbox.** It keeps images out of model context, but it does not stop an
  agent from reading the same file with other tools.
- **Permissions still apply.** The server reads the file with its own operating-system permissions. Do not enable this
  for untrusted agents.
- **Previews follow the message.** Collapsed or unmounted messages may not show a preview until they are visible again.
- **Verified with OpenCode `v2.0.21` and `v2.1.0`.** Other versions have not been validated.
