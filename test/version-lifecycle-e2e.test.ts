import { expect, setDefaultTimeout, test } from "bun:test"
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { installerEnvironment } from "../scripts/test-artifacts.mjs"
import { runCommand } from "../scripts/process.mjs"

setDefaultTimeout(60_000)
const repository = fileURLToPath(new URL("../", import.meta.url))

for (const mode of ["release", "prepack"] as const) {
test(`${mode}: real workspace bump publishes matching dependency metadata and tarballs to a loopback registry`, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "unicorn-release-lifecycle-"))
  const published = new Map<string, any>()
  const reads: string[] = []
  const registry = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    if (request.method === "GET") { reads.push(request.url); return Response.json({ error: "not_found" }, { status: 404 }) }
    if (request.method !== "PUT") return new Response("Unexpected method", { status: 405 })
    expect(request.headers.get("authorization")).toBe("Bearer synthetic-local-publish-token")
    const body = await request.json() as any
    published.set(body.name, body)
    return Response.json({ ok: true })
  } })
  try {
    const names = { child: "@max10240/opencode-plugin-show-img", unicorn: "@max10240/opencode-plugin-unicorn" }
    await mkdir(path.join(root, "scripts"))
    for (const file of ["check-versions.mjs", "sync-plugin-dependencies.mjs", "workspace.mjs"]) {
      await copyFile(path.join(repository, "scripts", file), path.join(root, "scripts", file))
    }
    await writeFile(path.join(root, "package.json"), JSON.stringify({ name: "release-lifecycle-fixture", private: true, workspaces: ["packages/*"] }))
    const actual = JSON.parse(await readFile(path.join(repository, "packages/opencode-plugin-unicorn/package.json"), "utf8"))
    const dependencyHook = actual.scripts.prepack.split(" && ")[0]
    expect(dependencyHook).toBe("node ../../scripts/sync-plugin-dependencies.mjs")
    for (const [directory, name] of Object.entries(names)) {
      const target = path.join(root, "packages", directory)
      await mkdir(target, { recursive: true })
      await writeFile(path.join(target, "index.js"), "export default {}\n")
      await writeFile(path.join(target, "package.json"), JSON.stringify({
        name, version: "1.0.8", type: "module", files: ["index.js"],
        ...(directory === "unicorn" ? { dependencies: { [names.child]: "1.0.8" }, scripts: { prepack: dependencyHook } } : {}),
      }))
    }
    const env = { ...installerEnvironment(root, { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR }), npm_config_update_notifier: "false" }
    await writeFile(env.npm_config_userconfig, `registry=${registry.url.origin}/\n//${registry.url.host}/:_authToken=synthetic-local-publish-token\n`)
    await writeFile(env.npm_config_globalconfig, "")
    await runCommand(["npm", "version", "--workspaces", "patch", "--git-tag-version=false", "--workspaces-update=false", "--ignore-scripts"], { cwd: root, env, capture: true })
    expect(reads).toEqual([])
    await mkdir(path.join(root, "node_modules"), { recursive: true })
    await symlink(path.join(repository, "node_modules/jsonc-parser"), path.join(root, "node_modules/jsonc-parser"), process.platform === "win32" ? "junction" : "dir")
    for (const directory of Object.keys(names)) {
      expect(JSON.parse(await readFile(path.join(root, "packages", directory, "package.json"), "utf8")).version).toBe("1.0.9")
    }
    await expect(runCommand(["node", "scripts/check-versions.mjs"], { cwd: root, env, capture: true })).rejects.toThrow("exactly")
    if (mode === "release") await runCommand(["node", "scripts/sync-plugin-dependencies.mjs"], { cwd: root, env, capture: true })
    await runCommand(["npm", "publish", "--workspaces", `--registry=${registry.url.origin}/`, "--tag=prerelease", "--access=public", "--provenance=false", "--ignore-scripts=false", "--json"], { cwd: root, env, capture: true })
    expect([...published.keys()]).toEqual([names.child, names.unicorn])
    const release = published.get(names.unicorn)
    expect(release["dist-tags"].prerelease).toBe("1.0.9")
    expect(release.versions["1.0.9"].dependencies[names.child]).toBe("1.0.9")
    const attachment = Object.values(release._attachments)[0] as { data: string }
    const archive = path.join(root, "published.tgz")
    await writeFile(archive, Buffer.from(attachment.data, "base64"))
    const packed = JSON.parse(await runCommand(["tar", "-xOf", archive, "package/package.json"], { cwd: root, env, capture: true }))
    expect(packed.version).toBe("1.0.9")
    expect(packed.dependencies[names.child]).toBe("1.0.9")
  } finally { registry.stop(true); await rm(root, { recursive: true, force: true }) }
})
}
