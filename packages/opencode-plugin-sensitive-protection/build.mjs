import solidPlugin from "@opentui/solid/bun-plugin"

const result = await Bun.build({
  entrypoints: ["./tui.tsx", "./src/tui.tsx"],
  outdir: "./dist",
  root: ".",
  naming: "[dir]/[name].js",
  target: "bun",
  // Bundle relative modules so TUI helpers ship in the published .js entry;
  // keep host/runtime packages external for the plugin sandbox.
  external: ["@opencode/*", "@opentui/*", "solid-js", "solid-js/*", "ini", "smol-toml", "yaml"],
  plugins: [solidPlugin],
})

if (!result.success) {
  for (const log of result.logs) console.error(log)
  process.exitCode = 1
}
