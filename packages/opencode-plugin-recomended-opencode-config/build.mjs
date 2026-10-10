const result = await Bun.build({
  entrypoints: ["./src/index.ts"],
  outdir: "./dist/src",
  target: "node",
  format: "esm",
  external: ["@opencode/plugin", "jsonc-parser", "marked"],
  loader: { ".md": "text" },
})
if (!result.success) throw new AggregateError(result.logs, "Recommended config build failed")
