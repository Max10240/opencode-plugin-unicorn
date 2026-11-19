import solidPlugin from "@opentui/solid/bun-plugin"

const server = await Bun.build({
  entrypoints: ["./src/index.ts"],
  outdir: "./dist/src",
  target: "node",
  format: "esm",
  external: ["@opencode/plugin", "jsonc-parser", "marked"],
  loader: { ".md": "text" },
})
if (!server.success) throw new AggregateError(server.logs, "Recommended config build failed")

const tui = await Bun.build({
  entrypoints: ["./src/tui.tsx"],
  outdir: "./dist",
  root: ".",
  target: "bun",
  external: ["*"],
  plugins: [solidPlugin],
})
if (!tui.success) throw new AggregateError(tui.logs, "Recommended config TUI build failed")
