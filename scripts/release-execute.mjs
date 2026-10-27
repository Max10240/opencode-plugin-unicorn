import { releasePackages } from "./release.mjs"

// Internal entry point used by the GitHub Actions workflow after the local
// release command has already bumped and pushed the version.
try {
  const stage = process.argv.includes("--stage")
  const result = await releasePackages({ stage })
  console.log(JSON.stringify(result))
} catch (error) {
  console.log(JSON.stringify({ status: "failed", message: error.message }))
  console.error(error)
  process.exitCode = 1
}
