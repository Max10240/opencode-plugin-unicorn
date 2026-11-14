import { execFileSync } from "node:child_process"
import { rmSync, writeFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const directory = path.dirname(fileURLToPath(import.meta.url))

// The runtime entry embeds the AI SDK so installations do not need @opencode/ai.
// Host-provided modules stay external: OpenCode resolves them from its own runtime.
rmSync(path.join(directory, "dist"), { recursive: true, force: true })
execFileSync("bun", ["x", "tsc", "-p", "tsconfig.build.json", "--emitDeclarationOnly"], {
  cwd: directory,
  stdio: "inherit",
})
execFileSync(
  "bun",
  [
    "build",
    "src/index.ts",
    "--bundle",
    "--minify",
    "--format=esm",
    "--target=bun",
    "--external",
    "@opencode/plugin*",
    "--external",
    "effect*",
    "--external",
    "@opentui/*",
    "--external",
    "solid-js*",
    "--outfile",
    "dist/src/index.js",
  ],
  { cwd: directory, stdio: "inherit" },
)
// Local plugin directories and existing package consumers resolve the root entrypoint.
writeFileSync(path.join(directory, "dist/index.js"), 'export { default } from "./src/index.js"\n')
