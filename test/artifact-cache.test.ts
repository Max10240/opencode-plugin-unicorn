import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { archivePackage, dependencyKey, installArchives, installerEnvironment, refreshLocalIntegrities } from "../scripts/test-artifacts.mjs"

const runtime = { node: "test-node", npm: "test-npm", arch: "test-arch", platform: "test-os" }

test("npm preserves network settings but ignores host credentials, config and preload overrides", () => {
  const env = installerEnvironment("/isolated", { PATH: "/usr/bin", HOME: "REAL_HOME", NODE_OPTIONS: "REAL_PRELOAD", HTTPS_PROXY: "https://proxy.example.invalid", npm_config_registry: "REAL_REGISTRY", NPM_CONFIG_USERCONFIG: "REAL_AUTH_FILE", OPENAI_API_KEY: "REAL_KEY" })
  expect(JSON.stringify(env)).not.toContain("REAL_")
  expect(env.HOME).toBe("/isolated")
  expect(env.npm_config_userconfig).toBe("/isolated/.npmrc")
  expect(env.HTTPS_PROXY).toBe("https://proxy.example.invalid")
})
async function fixture(run: (state: any) => Promise<void>) {
  const root = await mkdtemp(path.join(os.tmpdir(), "unicorn-cache-test-"))
  try {
    const directory = path.join(root, "artifacts")
    await mkdir(directory)
    const file = path.join(directory, "plugin-1.0.0.tgz")
    await writeFile(file, "first archive")
    const archives = [{ file, manifest: { name: "@test/plugin", version: "1.0.0", dependencies: { external: "^1.0.0" } } }]
    const cache = path.join(root, "cache")
    const calls: string[][] = []
    const fakeRun = async (args: string[]) => {
      calls.push(args)
      const install = args[args.indexOf("--prefix") + 1]
      if (args[1] === "install") {
        const manifest = JSON.parse(await readFile(path.join(install, "package.json"), "utf8"))
        const lock = { lockfileVersion: 3, packages: { "": manifest, "node_modules/@test/plugin": { version: "1.0.0", resolved: manifest.dependencies["@test/plugin"], integrity: "unused" }, "node_modules/external": { version: "1.2.3", resolved: "https://registry.npmjs.org/external/-/external-1.2.3.tgz", integrity: "external-integrity" } } }
        await writeFile(path.join(install, "package-lock.json"), JSON.stringify(lock))
      }
      return ""
    }
    await run({ root, archives, cache, calls, fakeRun, install: (name: string) => path.join(root, name) })
  } finally { await rm(root, { recursive: true, force: true }) }
}

test("dependency cache keys include manifests and toolchain, but not plugin code bytes", async () => fixture(async ({ archives }: any) => {
  const key = dependencyKey(archives, runtime)
  await writeFile(archives[0].file, "new implementation, same dependencies")
  expect(dependencyKey(archives, runtime)).toBe(key)
  for (const input of [{ ...runtime, node: "other" }, { ...runtime, npm: "other" }, { ...runtime, arch: "other" }]) expect(dependencyKey(archives, input)).not.toBe(key)
  expect(dependencyKey([{ ...archives[0], manifest: { ...archives[0].manifest, version: "2.0.0" } }], runtime)).not.toBe(key)
  expect(dependencyKey([{ ...archives[0], manifest: { ...archives[0].manifest, dependencies: { external: "^2" } } }], runtime)).not.toBe(key)
}))

test("warm installs use clean npm ci offline and the current archive's integrity", async () => fixture(async ({ root, archives, cache, calls, fakeRun, install }: any) => {
  expect((await installArchives(archives, install("first"), { cache, run: fakeRun, runtime })).cached).toBe(false)
  await writeFile(archives[0].file, "second archive")
  expect((await installArchives(archives, install("second"), { cache, run: fakeRun, runtime })).cached).toBe(true)
  expect(calls.map((args: string[]) => args[1])).toEqual(["install", "ci"])
  expect(calls[1]).toContain("--offline")
  expect(calls.every((args: string[]) => args.includes("--ignore-scripts"))).toBe(true)
  expect(calls.every((args: string[]) => args.includes("--package-lock=true"))).toBe(true)
  const lock = JSON.parse(await readFile(path.join(root, "second/package-lock.json"), "utf8"))
  expect(lock.packages["node_modules/@test/plugin"].integrity).toBe(`sha512-${createHash("sha512").update("second archive").digest("base64")}`)
  expect(lock.packages["node_modules/external"].integrity).toBe("external-integrity")
}))

test("fresh validation bypasses a valid cache", async () => fixture(async ({ archives, cache, calls, fakeRun, install }: any) => {
  await installArchives(archives, install("first"), { cache, run: fakeRun, runtime })
  await installArchives(archives, install("second"), { cache, run: fakeRun, runtime, fresh: true })
  expect(calls.map((args: string[]) => args[1])).toEqual(["install", "install"])
}))

test("tampered or partial cache records trigger fresh resolution", async () => fixture(async ({ archives, cache, calls, fakeRun, install }: any) => {
  await installArchives(archives, install("first"), { cache, run: fakeRun, runtime })
  const record = path.join(cache, "locks", (await readdir(path.join(cache, "locks")))[0])
  await writeFile(record, '{"key":"wrong","lock":{}}')
  await installArchives(archives, install("second"), { cache, run: fakeRun, runtime })
  expect(calls.map((args: string[]) => args[1])).toEqual(["install", "install"])
}))

test("a failed offline install removes partial output before retrying, and fresh errors propagate", async () => fixture(async ({ archives, cache, calls, fakeRun, install }: any) => {
  await installArchives(archives, install("first"), { cache, run: fakeRun, runtime })
  const target = install("second")
  const run = async (args: string[]) => {
    if (args[1] === "ci") {
      await mkdir(path.join(target, "node_modules"))
      await writeFile(path.join(target, "node_modules/partial"), "bad")
      throw new Error("missing npm cache entry")
    }
    await expect(access(path.join(target, "node_modules/partial"))).rejects.toThrow()
    return fakeRun(args)
  }
  expect((await installArchives(archives, target, { cache, run, runtime })).cached).toBe(false)
  await expect(installArchives(archives, install("third"), { cache, runtime, fresh: true, run: async () => { throw new Error("install failed") } })).rejects.toThrow("install failed")
  expect(calls.map((args: string[]) => args[1])).toEqual(["install", "install"])
}))

test("cached locks cannot silently redirect a local package or change the declared dependencies", async () => fixture(async ({ archives, install }: any) => {
  const manifest = await archivePackage(archives, install("one"))
  const lock = { lockfileVersion: 3, packages: { "": manifest, "node_modules/@test/plugin": { version: "1.0.0", resolved: "file:wrong.tgz" } } }
  await expect(refreshLocalIntegrities(lock, archives, manifest)).rejects.toThrow("does not match")
  await expect(refreshLocalIntegrities({ ...lock, lockfileVersion: 2 }, archives, manifest)).rejects.toThrow("does not match")
}))
