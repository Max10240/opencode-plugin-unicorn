import { expect } from "bun:test"
import { createHash } from "node:crypto"
import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { installerEnvironment } from "../scripts/test-artifacts.mjs"
import { mapLimit } from "../scripts/workspace.mjs"
import { runCommand, timed } from "../scripts/process.mjs"

type Archive = { file: string; manifest: Record<string, any> }
const legacyVersion = "1.0.1"

export async function installUnicornOnly(archives: readonly Archive[], root: string, dependencyLock?: string) {
  const unicorn = archives.find((item) => item.manifest.name === "@max10240/opencode-plugin-unicorn")!
  const children = archives.filter((item) => item !== unicorn)
  const artifacts = path.join(root, "registry-artifacts")
  await mkdir(artifacts, { recursive: true })
  const packages = await mapLimit(children, 2, async (item: Archive, index: number) => {
    const directory = path.join(root, `legacy-${index}`)
    await mkdir(directory)
    const old = { name: item.manifest.name, version: legacyVersion }
    await writeFile(path.join(directory, "package.json"), JSON.stringify(old))
    const env = installerEnvironment(directory)
    const packed = JSON.parse(await runCommand(["npm", "pack", "--ignore-scripts", "--update-notifier=false", "--json", "--pack-destination", artifacts], { cwd: directory, env, capture: true }))
    return { manifest: item.manifest, current: await readFile(item.file), old, legacy: await readFile(path.join(artifacts, packed[0].filename)) }
  })
  const blobs = new Map<string, Buffer>()
  const requested = new Set<string>()
  const registry = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    const pathname = decodeURIComponent(new URL(request.url).pathname)
    const blob = blobs.get(pathname)
    if (blob) return new Response(blob, { headers: { "content-type": "application/octet-stream", "cache-control": "no-store" } })
    const item = packages.find((entry: any) => pathname === `/${entry.manifest.name}`)
    if (!item) return new Response("Not found", { status: 404 })
    requested.add(item.manifest.name)
    const version = (manifest: Record<string, any>, bytes: Buffer, suffix: string) => {
      const hash = createHash("sha256").update(bytes).digest("hex")
      const pathname = `/tarballs/${manifest.name.slice(manifest.name.indexOf("/") + 1)}-${suffix}-${hash}.tgz`
      blobs.set(pathname, bytes)
      return { ...manifest, dist: { tarball: `${new URL(request.url).origin}${pathname}`, integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}` } }
    }
    return Response.json({ name: item.manifest.name, "dist-tags": { latest: legacyVersion, prerelease: item.manifest.version }, versions: {
      [legacyVersion]: version(item.old, item.legacy, "legacy"),
      [item.manifest.version]: version(item.manifest, item.current, "current"),
    } }, { headers: { "cache-control": "no-store" } })
  } })
  const install = async (directory: string, dependencies: Record<string, string>, lock?: any, localOnly = false) => {
    await mkdir(directory, { recursive: true })
    const env = installerEnvironment(directory)
    await writeFile(env.npm_config_userconfig, `@max10240:registry=${registry.url.origin}/\n`)
    await writeFile(env.npm_config_globalconfig, "")
    await writeFile(path.join(directory, "package.json"), JSON.stringify({ name: "unicorn-only-install-test", private: true, dependencies }))
    if (lock) await writeFile(path.join(directory, "package-lock.json"), JSON.stringify(lock))
    await runCommand(["npm", "install", `--registry=${lock || localOnly ? registry.url.origin + "/" : "https://registry.npmjs.org/"}`, lock ? "--prefer-offline" : "--prefer-online", "--ignore-scripts", "--no-audit", "--no-fund", "--update-notifier=false", "--cache",
      path.join(process.env.UNICORN_TEST_CACHE_DIR ?? path.join(os.tmpdir(), "opencode", "unicorn-test-cache"), "npm")], { cwd: directory, env, capture: true })
  }
  try {
    // Control: reproduce npm's preference for a matching latest tag over a newer prerelease-tagged version.
    const probe = path.join(root, "range-control")
    const showImg = "@max10240/opencode-plugin-show-img"
    await install(probe, { [showImg]: "^1" }, undefined, true)
    expect(JSON.parse(await readFile(path.join(probe, "node_modules", showImg, "package.json"), "utf8")).version).toBe(legacyVersion)

    const directory = path.join(root, "unicorn-only")
    const dependencies = { [unicorn.manifest.name]: `file:${path.relative(directory, unicorn.file)}` }
    let seed: any
    if (dependencyLock && process.env.UNICORN_TEST_FRESH_INSTALL !== "1") {
      seed = JSON.parse(await readFile(dependencyLock, "utf8"))
      seed.name = "unicorn-only-install-test"
      seed.packages[""].name = seed.name
      seed.packages[""].dependencies = dependencies
      const parent = seed.packages[`node_modules/${unicorn.manifest.name}`]
      parent.resolved = dependencies[unicorn.manifest.name]
      parent.integrity = `sha512-${createHash("sha512").update(await readFile(unicorn.file)).digest("base64")}`
      // Freeze only external dependencies. All child plugins must still resolve through the adversarial registry.
      for (const item of children) delete seed.packages[`node_modules/${item.manifest.name}`]
    }
    if (seed) {
      try { await timed("npm install (Unicorn only, cached external dependencies)", () => install(directory, dependencies, seed)) }
      catch {
        await rm(path.join(directory, "node_modules"), { recursive: true, force: true })
        await rm(path.join(directory, "package-lock.json"), { force: true })
        seed = undefined
      }
    }
    if (!seed) await timed("npm install (Unicorn only, stale latest tag)", () => install(directory, dependencies))
    expect(Object.keys(JSON.parse(await readFile(path.join(directory, "package.json"), "utf8")).dependencies)).toEqual([unicorn.manifest.name])
    const lock = JSON.parse(await readFile(path.join(directory, "package-lock.json"), "utf8"))
    for (const item of children) {
      const manifest = JSON.parse(await readFile(path.join(directory, "node_modules", item.manifest.name, "package.json"), "utf8"))
      expect(manifest.version).toBe(unicorn.manifest.version)
      expect(requested.has(item.manifest.name)).toBe(true)
      expect(lock.packages[`node_modules/${item.manifest.name}`].integrity).toBe(`sha512-${createHash("sha512").update(await readFile(item.file)).digest("base64")}`)
    }
    return path.join(directory, "node_modules", unicorn.manifest.name)
  } finally { registry.stop(true) }
}
