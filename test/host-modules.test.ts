import { expect, test } from "bun:test"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { workspacePackages } from "../scripts/workspace.mjs"

const repository = path.resolve(fileURLToPath(import.meta.url), "../..")
const tuiModules = ["@opentui/core", "@opentui/solid", "solid-js"] as const

test("plugins take host-provided modules from OpenCode instead of installing them", async () => {
  const packages = await workspacePackages(repository)
  for (const { manifest } of packages) {
    if (!manifest.name?.startsWith("@max10240/opencode-plugin-")) continue

    expect(manifest.dependencies?.["@opencode/plugin"]).toBeUndefined()
    expect(manifest.optionalDependencies?.["@opencode/plugin"]).toBeUndefined()
    expect(manifest.peerDependencies?.["@opencode/plugin"]).toBeDefined()
    expect(manifest.peerDependenciesMeta?.["@opencode/plugin"]?.optional).toBe(true)
    expect(manifest.devDependencies?.["@opencode/plugin"]).toBeDefined()

    if (manifest.name.endsWith("image-gen")) {
      expect(manifest.dependencies?.effect).toBeUndefined()
      expect(manifest.peerDependencies?.effect).toBeDefined()
      expect(manifest.peerDependenciesMeta?.effect?.optional).toBe(true)
      expect(manifest.devDependencies?.effect).toBeDefined()
      expect(manifest.dependencies?.["@opencode/ai"]).toBeUndefined()
      expect(manifest.devDependencies?.["@opencode/ai"]).toBeDefined()
    }

    for (const name of tuiModules) {
      if (!manifest.peerDependencies?.[name]) continue
      expect(manifest.peerDependenciesMeta?.[name]?.optional).toBe(true)
    }
  }
})
