import { rm } from "node:fs/promises"
import solidPlugin from "@opentui/solid/bun-plugin"

for (const name of ["global-config.js", "global-config.d.ts"]) {
  await rm(new URL(`./dist/src/${name}`, import.meta.url), { force: true })
}

const tui = await Bun.build({
  entrypoints: ["./src/status-dialog.tsx"],
  outdir: "./dist",
  root: ".",
  target: "bun",
  external: ["*"],
  plugins: [solidPlugin],
})
if (!tui.success) throw new AggregateError(tui.logs, "Unicorn TUI build failed")
