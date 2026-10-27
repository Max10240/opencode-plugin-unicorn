import { expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {
  compareVersions,
  parseVersion,
  planRelease,
  registryPackagePath,
  registryVersionUrl,
  releaseOptions,
  releasePackages,
  tarballIntegrity,
} from "../scripts/release.mjs"

const CHILD = "@max10240/opencode-plugin-show-img"
const UNICORN = "@max10240/opencode-plugin-unicorn"

test("version helpers compare stable versions", () => {
  expect(parseVersion("1.0.12")).toMatchObject({ major: 1, minor: 0, patch: 12 })
  expect(compareVersions("1.0.12", "1.0.11")).toBeGreaterThan(0)
  expect(compareVersions("1.1.0", "1.0.99")).toBeGreaterThan(0)
  expect(() => compareVersions("latest", "1.0.0")).toThrow("Invalid version")
})

test("registry URLs encode scoped package names once", () => {
  expect(registryPackagePath(CHILD)).toBe("@max10240%2Fopencode-plugin-show-img")
  expect(registryVersionUrl("https://registry.npmjs.org/", CHILD, "1.0.12")).toBe(
    "https://registry.npmjs.org/@max10240%2Fopencode-plugin-show-img/1.0.12",
  )
})

test("release options separate direct publish, stage and dry run", () => {
  expect(releaseOptions([])).toMatchObject({ stage: false, dryRun: false, tag: "latest" })
  expect(releaseOptions(["--stage", "--dry-run"])).toMatchObject({ stage: true, dryRun: true })
  expect(releaseOptions(["--tag=next", "--registry=https://example.test/"])).toMatchObject({ tag: "next", registry: "https://example.test/" })
  expect(() => releaseOptions(["--unknown"])).toThrow("Unknown release option")
})

test("tarball integrity uses sha512 base64", () => {
  expect(tarballIntegrity(Buffer.from("hello"))).toBe("sha512-m3HSJL1i83hdltRq0+o9czGb+8KJDKra4t/3JRlnPKcjI8PZm6XBHXx6zG4UuMXaDEZjR1wuXDre9G9zvN7AQw==")
})

async function fixture({ latest = "1.0.10", version = "1.0.11" } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "unicorn-release-test-"))
  await mkdir(path.join(root, "packages", "child"), { recursive: true })
  await mkdir(path.join(root, "packages", "unicorn"), { recursive: true })
  await writeFile(path.join(root, "packages/child/package.json"), JSON.stringify({ name: CHILD, version }))
  await writeFile(path.join(root, "packages/unicorn/package.json"), JSON.stringify({
    name: UNICORN,
    version,
    dependencies: { [CHILD]: version },
  }))

  const latestVersions = new Map([[CHILD, latest], [UNICORN, latest]])
  const versions = new Map()
  const calls = []
  const fetchImpl = async (url) => {
    const decoded = decodeURIComponent(new URL(url).pathname).replace(/^\//, "")
    const parts = decoded.split("/")
    const tail = parts.pop()
    const name = parts.join("/")
    if (tail === "latest") {
      const value = latestVersions.get(name)
      return value ? Response.json({ version: value }) : new Response("not found", { status: 404 })
    }
    const value = versions.get(`${name}@${tail}`)
    return value ? Response.json({ dist: { integrity: value.integrity } }) : new Response("not found", { status: 404 })
  }
  const pack = async (_root, item) => ({
    file: path.join(root, "packed", `${item.manifest.name.replace(/[@/]/g, "-")}.tgz`),
    filename: `${item.manifest.name.replace(/[@/]/g, "-")}.tgz`,
    integrity: `sha512-${item.manifest.name}`,
  })
  const run = async (args) => { calls.push([...args]); return "" }

  return {
    root,
    latestVersions,
    versions,
    calls,
    fetchImpl,
    pack,
    run,
    cleanup: () => rm(root, { recursive: true, force: true }),
  }
}

test("plan rejects a version that is not newer than registry latest", async () => {
  const fx = await fixture({ version: "1.0.10" })
  try {
    await expect(planRelease({ root: fx.root, fetchImpl: fx.fetchImpl, pack: fx.pack, run: fx.run })).rejects.toThrow("not newer")
  } finally { await fx.cleanup() }
})

test("plan publishes missing packages and skips identical existing versions", async () => {
  const fx = await fixture()
  try {
    fx.versions.set(`${CHILD}@1.0.11`, { integrity: `sha512-${CHILD}` })
    const planned = await planRelease({ root: fx.root, fetchImpl: fx.fetchImpl, pack: fx.pack, run: fx.run })
    const actions = new Map(planned.plan.map((item) => [item.name, item.action]))
    expect(actions.get(CHILD)).toBe("skip")
    expect(actions.get(UNICORN)).toBe("publish")
    expect(planned.plan.map((item) => item.name)).toEqual([CHILD, UNICORN])
    await planned.cleanup()
  } finally { await fx.cleanup() }
})

test("plan refuses the same version with different content", async () => {
  const fx = await fixture()
  try {
    fx.versions.set(`${CHILD}@1.0.11`, { integrity: "sha512-different" })
    await expect(planRelease({ root: fx.root, fetchImpl: fx.fetchImpl, pack: fx.pack, run: fx.run })).rejects.toThrow("differs")
  } finally { await fx.cleanup() }
})

test("release publishes leaves before Unicorn and never bumps versions", async () => {
  const fx = await fixture()
  try {
    const result = await releasePackages({
      root: fx.root,
      build: false,
      verify: false,
      fetchImpl: fx.fetchImpl,
      pack: fx.pack,
      run: fx.run,
      log: () => {},
    })
    expect(result).toMatchObject({ version: "1.0.11", published: [CHILD, UNICORN] })
    const publishes = fx.calls.filter((args) => args[0] === "npm" && args[1] === "publish")
    expect(publishes).toHaveLength(2)
    expect(publishes.map((args) => args[2])).toEqual([
      expect.stringContaining("show-img"),
      expect.stringContaining("unicorn"),
    ])
    expect(fx.calls.some((args) => args.includes("version"))).toBe(false)
  } finally { await fx.cleanup() }
})

test("staged release uses npm stage publish and does not wait for the registry", async () => {
  const fx = await fixture()
  try {
    const result = await releasePackages({
      root: fx.root,
      build: false,
      stage: true,
      fetchImpl: fx.fetchImpl,
      pack: fx.pack,
      run: fx.run,
      log: () => {},
    })
    expect(result).toMatchObject({ version: "1.0.11", stage: true })
    const staged = fx.calls.filter((args) => args[0] === "npm" && args[1] === "stage" && args[2] === "publish")
    expect(staged).toHaveLength(2)
  } finally { await fx.cleanup() }
})

test("dry run builds the plan without publishing", async () => {
  const fx = await fixture()
  try {
    const result = await releasePackages({
      root: fx.root,
      build: false,
      dryRun: true,
      fetchImpl: fx.fetchImpl,
      pack: fx.pack,
      run: fx.run,
      log: () => {},
    })
    expect(result).toMatchObject({ dryRun: true, version: "1.0.11" })
    expect(fx.calls.some((args) => args[0] === "npm" && (args[1] === "publish" || args[1] === "stage"))).toBe(false)
  } finally { await fx.cleanup() }
})
