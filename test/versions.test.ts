import { expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { assertPluginVersions, checkPluginVersions } from "../scripts/check-versions.mjs"

const unicorn = { name: "@max10240/opencode-plugin-unicorn", version: "1.0.5" }

test("all current plugin packages share the Unicorn version", async () => {
  const result = await checkPluginVersions()
  const current = JSON.parse(await readFile(new URL("../packages/opencode-plugin-unicorn/package.json", import.meta.url), "utf8"))
  expect(result.count).toBeGreaterThanOrEqual(6)
  expect(result.version).toBe(current.version)
})

test("publishing does not automatically create a commit", async () => {
  const workspace = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"))
  expect(workspace.scripts["postpublish:all"]).toBeUndefined()
})

test("rejects a new plugin with its own initial version", () => {
  const plugin = { name: "@max10240/opencode-plugin-new-feature", version: "1.0.0" }
  expect(() => assertPluginVersions([unicorn, plugin])).toThrow(`${plugin.name}=1.0.0`)
  expect(assertPluginVersions([unicorn, { ...plugin, version: unicorn.version }])).toEqual({ version: unicorn.version, count: 2 })
})

test("rejects missing versions and a missing Unicorn reference", () => {
  expect(() => assertPluginVersions([unicorn, { name: "@max10240/opencode-plugin-incomplete" }])).toThrow("missing")
  expect(() => assertPluginVersions([])).toThrow("shared plugin version")
  expect(() => assertPluginVersions([{ ...unicorn, version: "" }])).toThrow("shared plugin version")
})

test("does not force the private workspace or unrelated packages to use the plugin version", () => {
  expect(assertPluginVersions([unicorn,
    { name: "@max10240/opencode-plugin-unicorn-workspace", version: "0.0.1", private: true },
    { name: "unrelated-helper", version: "2.0.0" },
  ]).count).toBe(1)
})

test("discovers added package directories rather than relying on a fixed plugin list", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "opencode-version-check-"))
  try {
    const packages = path.join(root, "packages")
    await mkdir(path.join(packages, "unicorn"), { recursive: true })
    await mkdir(path.join(packages, "new-plugin"))
    await mkdir(path.join(packages, "no-manifest"))
    await writeFile(path.join(packages, "unicorn/package.json"), JSON.stringify(unicorn))
    await writeFile(path.join(packages, "new-plugin/package.json"), JSON.stringify({ name: "@max10240/opencode-plugin-future", version: "1.0.0" }))
    await expect(checkPluginVersions(root)).rejects.toThrow("opencode-plugin-future=1.0.0")
    await writeFile(path.join(packages, "new-plugin/package.json"), JSON.stringify({ name: "@max10240/opencode-plugin-future", version: unicorn.version }))
    expect(await checkPluginVersions(root)).toEqual({ version: unicorn.version, count: 2 })
  } finally { await rm(root, { recursive: true, force: true }) }
})
