import solidPlugin from "@opentui/solid/bun-plugin"

const result = await Bun.build({
  entrypoints: ["./tui.tsx", "./src/tui.tsx"],
  outdir: "./dist",
  root: ".",
  naming: "[dir]/[name].js",
  target: "bun",
  external: ["*"],
  plugins: [solidPlugin],
})

if (!result.success) {
  for (const log of result.logs) console.error(log)
  process.exitCode = 1
}
