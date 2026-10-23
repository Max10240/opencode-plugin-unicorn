import { expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { assertPluginVersions, checkPluginVersions } from "../scripts/check-versions.mjs"
import { syncPluginDependencies } from "../scripts/sync-plugin-dependencies.mjs"

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
  expect(workspace.scripts["publish:all"]).toStartWith("bun run check:fresh &&")
  expect(workspace.scripts["publish:all"]).toContain("--git-tag-version=false")
  expect(workspace.scripts["publish:all"]).toContain("npm version --ws patch --git-tag-version=false --workspaces-update=false && bun run sync:versions && bun run build")
})

test("runtime child dependencies must pin the exact shared version, not prefer an older latest tag", () => {
  const child = { name: "@max10240/opencode-plugin-show-img", version: unicorn.version }
  for (const field of ["dependencies", "optionalDependencies"]) {
    for (const value of ["^1", `^${unicorn.version}`, `~${unicorn.version}`, "latest", "prerelease", "1.0.1"]) {
      expect(() => assertPluginVersions([{ ...unicorn, [field]: { [child.name]: value } }, child])).toThrow("exactly")
    }
  }
  expect(assertPluginVersions([{ ...unicorn, dependencies: { [child.name]: child.version, external: "^1" } }, child]).count).toBe(2)
})

test("dependency synchronization follows a version bump without changing unrelated manifest formatting", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "opencode-dependency-sync-"))
  try {
    await mkdir(path.join(root, "packages", "unicorn"), { recursive: true })
    await mkdir(path.join(root, "packages", "child"))
    const child = { name: "@max10240/opencode-plugin-show-img", version: "1.0.9" }
    const file = path.join(root, "packages/unicorn/package.json")
    const original = `${JSON.stringify({ ...unicorn, version: child.version, dependencies: { [child.name]: "^1", external: "^2" } })}\n`
    await writeFile(file, original)
    await writeFile(path.join(root, "packages/child/package.json"), JSON.stringify(child))
    await expect(checkPluginVersions(root)).rejects.toThrow("exactly")
    await syncPluginDependencies(root)
    expect(await readFile(file, "utf8")).toBe(original.replace('"^1"', '"1.0.9"'))
    expect((await checkPluginVersions(root)).version).toBe(child.version)
    const before = await stat(file)
    await Bun.sleep(10)
    await syncPluginDependencies(root)
    expect((await stat(file)).mtimeMs).toBe(before.mtimeMs)
  } finally { await rm(root, { recursive: true, force: true }) }
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
