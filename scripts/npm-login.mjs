import { runWithAuthLinks } from "./auth-process.mjs"

const registry = process.env.NPM_REGISTRY ?? "https://registry.npmjs.org/"

try {
  await runWithAuthLinks(["npm", "login", "--auth-type=web", `--registry=${registry}`], {
    registry,
    log: (message) => console.error(message),
  })
  console.log(`[npm-login] logged in to ${registry}`)
} catch (error) {
  console.error(`[npm-login] ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
}
