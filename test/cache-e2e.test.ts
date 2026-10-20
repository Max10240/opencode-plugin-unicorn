import { expect, setDefaultTimeout, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { runCommand } from "../scripts/process.mjs"
import { installArchives } from "../scripts/test-artifacts.mjs"

setDefaultTimeout(60_000)

test("real offline npm ci installs changed same-version plugin bytes, not cached plugin code", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "unicorn-real-cache-"))
  try {
    const source = path.join(root, "source")
    const artifacts = path.join(root, "artifacts")
    await mkdir(source); await mkdir(artifacts)
    const manifest = { name: "cache-test-plugin", version: "1.0.0", type: "module", files: ["index.js"] }
    await writeFile(path.join(source, "package.json"), JSON.stringify(manifest))
    const cache = path.join(root, "cache")
    for (const value of [1, 2, 3]) {
      await writeFile(path.join(source, "index.js"), `export default ${value}\n`)
      const packed = JSON.parse(await runCommand(["npm", "pack", "--ignore-scripts", "--json", "--pack-destination", artifacts], { cwd: source, capture: true }))[0]
      const archive = { file: path.join(artifacts, packed.filename), manifest }
      const install = path.join(root, "install")
      const result = await installArchives([archive], install, { cache, fresh: value === 3 })
      expect(result.cached).toBe(value === 2)
      expect(await readFile(path.join(install, "node_modules/cache-test-plugin/index.js"), "utf8")).toBe(`export default ${value}\n`)
    }
  } finally { await rm(root, { recursive: true, force: true }) }
})
