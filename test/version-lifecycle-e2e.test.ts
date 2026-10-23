import { expect, setDefaultTimeout, test } from "bun:test"
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { installerEnvironment } from "../scripts/test-artifacts.mjs"
import { buildFingerprint } from "../scripts/workspace.mjs"
import { runCommand } from "../scripts/process.mjs"
import { planVersionBump, publishAll, VERSION_COMMAND } from "../scripts/publish.mjs"

setDefaultTimeout(60_000)
const repository = fileURLToPath(new URL("../", import.meta.url))

for (const mode of ["release", "ignore-scripts", "ignore-scripts-config", "dry-run", "prepack"] as const) {
  test(`${mode}: real npm lifecycle preserves versioned builds and dependency metadata`, async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "unicorn-release-lifecycle-"))
    const published = new Map<string, any>()
    const reads: string[] = []
    const registry = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
      if (request.method === "GET") {
        reads.push(request.url)
        return new URL(request.url).pathname === "/-/whoami" ? Response.json({ username: "fixture-user" }) : Response.json({ error: "not_found" }, { status: 404 })
      }
      if (request.method !== "PUT") return new Response("Unexpected method", { status: 405 })
      expect(request.headers.get("authorization")).toBe("Bearer synthetic-local-publish-token")
      const body = await request.json() as any
      published.set(body.name, body)
      return Response.json({ ok: true })
    } })
    try {
      const names = { child: "@max10240/opencode-plugin-show-img", unicorn: "@max10240/opencode-plugin-unicorn" }
      await mkdir(path.join(root, "scripts"))
      await mkdir(path.join(root, "test"))
      await mkdir(path.join(root, "artifacts"))
      for (const file of ["check-versions.mjs", "sync-plugin-dependencies.mjs", "workspace.mjs"]) {
        await copyFile(path.join(repository, "scripts", file), path.join(root, "scripts", file))
      }
      await writeFile(path.join(root, "package.json"), JSON.stringify({ name: "release-lifecycle-fixture", private: true, workspaces: ["packages/*"], scripts: { build: "node build.mjs" } }))
      await writeFile(path.join(root, "build.mjs"), `import { execFileSync } from "node:child_process";
for (const directory of ["child", "unicorn"]) execFileSync(process.execPath, ["build.mjs"], { cwd: "packages/" + directory, stdio: "inherit" });
`)
      const actual = JSON.parse(await readFile(path.join(repository, "packages/opencode-plugin-unicorn/package.json"), "utf8"))
      const dependencyHook = actual.scripts.prepack.split(" && ")[0]
      expect(dependencyHook).toBe("node ../../scripts/sync-plugin-dependencies.mjs")
      for (const [directory, name] of Object.entries(names)) {
        const target = path.join(root, "packages", directory)
        await mkdir(target, { recursive: true })
        await writeFile(path.join(target, "build.mjs"), `import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
const manifest = JSON.parse(readFileSync("package.json", "utf8"));
if (manifest.dependencies && !readFileSync("../child/dist/index.js", "utf8").includes(manifest.version)) throw new Error("Child build is stale");
mkdirSync("dist", { recursive: true });
writeFileSync("dist/index.js", "export default " + JSON.stringify(manifest.version) + ";\\n");
appendFileSync("../../build-events.log", manifest.name + "@" + manifest.version + "\\n");
`)
        await writeFile(path.join(target, "package.json"), JSON.stringify({
          name, version: "1.0.8", type: "module", files: ["dist/index.js"],
          scripts: { build: "node build.mjs", prepack: `${directory === "unicorn" ? dependencyHook + " && " : ""}npm run build` },
          ...(directory === "unicorn" ? { dependencies: { [names.child]: "1.0.8" } } : {}),
        }))
      }
      const env = { ...installerEnvironment(root, { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR }), npm_config_update_notifier: "false", ...(mode === "dry-run" ? { npm_config_dry_run: "true" } : {}) }
      await writeFile(env.npm_config_userconfig, `registry=${registry.url.origin}/\n//${registry.url.host}/:_authToken=synthetic-local-publish-token\n${mode === "ignore-scripts-config" ? "ignore-scripts=true\n" : ""}`)
      await writeFile(env.npm_config_globalconfig, "")
      await mkdir(path.join(root, "node_modules"), { recursive: true })
      await symlink(path.join(repository, "node_modules/jsonc-parser"), path.join(root, "node_modules/jsonc-parser"), process.platform === "win32" ? "junction" : "dir")
      const args = [`--registry=${registry.url.origin}/`, "--tag=prerelease", "--access=public", "--provenance=false", "--json", ...(mode === "ignore-scripts" ? ["--ignore-scripts=0"] : [])]
      const run = async (command: string[], options: any) => {
        if (command[0] === "npm" && command[1] === "publish") expect(command).toContain(`--registry=${registry.url.origin}/`)
        return runCommand(command, { ...options, capture: true })
      }
      if (mode === "prepack") {
        await run(["npm", "run", "build", "--workspaces"], { cwd: root, env })
        const plan = await planVersionBump(root)
        expect(plan.after).toBe("1.0.9")
        expect(JSON.parse(await readFile(path.join(root, "packages/unicorn/package.json"), "utf8")).version).toBe("1.0.8")
        await run([...VERSION_COMMAND, "--ignore-scripts"], { cwd: root, env })
        expect(reads).toEqual([])
        await expect(run(["node", "scripts/check-versions.mjs"], { cwd: root, env })).rejects.toThrow("exactly")
        await run(["npm", "publish", "--workspaces", ...args, "--ignore-scripts=false"], { cwd: root, env })
      } else {
        const result = await publishAll({ root, args, env, run, log: () => {}, check: async (workflow: string, options: any) => {
          expect(workflow).toBe("check")
          expect(options.fresh).toBe(true)
          await options.run(["npm", "run", "build", "--workspaces"], { cwd: root })
          await options.run(["npm", "pack", "--workspaces", "--ignore-scripts", "--json", "--pack-destination", path.join(root, "artifacts")], { cwd: root, env })
          expect((await readdir(path.join(root, "artifacts"))).filter((file) => file.endsWith(".tgz"))).toHaveLength(2)
          return { root, fingerprint: await buildFingerprint(root) }
        } })
        expect(result).toEqual({ dryRun: mode === "dry-run", version: "1.0.9" })
      }
      const events = (await readFile(path.join(root, "build-events.log"), "utf8")).trim().split("\n")
      expect(events).toEqual([`${names.child}@1.0.8`, `${names.unicorn}@1.0.8`, ...(mode === "dry-run" ? [] : [`${names.child}@1.0.9`, `${names.unicorn}@1.0.9`])])
      if (mode === "dry-run") {
        expect(reads).toEqual([])
        expect(published.size).toBe(0)
        const manifest = JSON.parse(await readFile(path.join(root, "packages/unicorn/package.json"), "utf8"))
        expect(manifest.version).toBe("1.0.8")
        expect(manifest.dependencies[names.child]).toBe("1.0.8")
      } else {
        expect([...published.keys()]).toEqual([names.child, names.unicorn])
        const release = published.get(names.unicorn)
        expect(release["dist-tags"].prerelease).toBe("1.0.9")
        expect(release.versions["1.0.9"].dependencies[names.child]).toBe("1.0.9")
        for (const [name, body] of published) {
          const attachment = Object.values(body._attachments)[0] as { data: string }
          const archive = path.join(root, "published.tgz")
          await writeFile(archive, Buffer.from(attachment.data, "base64"))
          const packed = JSON.parse(await run(["tar", "-xOf", archive, "package/package.json"], { cwd: root, env }))
          expect(packed.name).toBe(name)
          expect(packed.version).toBe("1.0.9")
          if (name === names.unicorn) expect(packed.dependencies[names.child]).toBe("1.0.9")
          expect(await run(["tar", "-xOf", archive, "package/dist/index.js"], { cwd: root, env })).toContain('"1.0.9"')
        }
      }
    } finally { registry.stop(true); await rm(root, { recursive: true, force: true }) }
  })
}
