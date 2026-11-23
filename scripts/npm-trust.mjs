import { runWithAuthLinks } from "./auth-process.mjs"

const packages = process.argv.slice(2)
if (packages.length === 0) {
  console.error("usage: node scripts/npm-trust.mjs <package...>")
  process.exit(2)
}

const registry = process.env.NPM_REGISTRY ?? "https://registry.npmjs.org/"
for (const pkg of packages) {
  console.error(`[npm-trust] configuring ${pkg}`)
  await runWithAuthLinks([
    "npm", "trust", "github", pkg,
    "--file", "publish.yml",
    "--repo", "Max10240/opencode-plugin-unicorn",
    "--environment", "npm-publish",
    "--allow-publish",
    "--allow-stage-publish",
    `--registry=${registry}`,
    "-y",
  ], {
    registry,
    log: (message) => console.error(message),
  })
  console.error(`[npm-trust] configured ${pkg}`)
}
