import { expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {
  assertCleanWorkspace,
  compareVersions,
  parseReleaseArgs,
  parseVersion,
  planRelease,
  registryPackagePath,
  registryVersionUrl,
  release,
  releasePackages,
  resolveTargetVersion,
  tarballIntegrity,
  triggerCi,
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

test("release arguments require an explicit release type and default to patch", () => {
  expect(parseReleaseArgs(["--release-type=local-publish"])).toMatchObject({ releaseType: "local-publish", version: "patch", dryRun: false })
  expect(parseReleaseArgs(["--release-type=ci-stage", "--version=minor", "--dry-run"])).toMatchObject({ releaseType: "ci-stage", version: "minor", dryRun: true })
  expect(parseReleaseArgs(["--release-type=local-publish", "--version=1.2.3"])).toMatchObject({ version: "1.2.3" })
  expect(() => parseReleaseArgs([])).toThrow("Missing required --release-type")
  expect(() => parseReleaseArgs(["--release-type=nope"])).toThrow("Invalid --release-type")
  expect(() => parseReleaseArgs(["--release-type=local-publish", "--version=latest"])).toThrow("Invalid --version")
  expect(() => parseReleaseArgs(["--release-type=ci-publish", "--tag=next"])).toThrow("--tag is not supported")
  expect(() => parseReleaseArgs(["--release-type=local-publish", "--unknown"])).toThrow("Unknown release option")
})

test("workspace checks allow only sync files and optionally version files", async () => {
  const sync = async () => " M packages/opencode-plugin-recomended-opencode-config/rules/AGENTS.md\n"
  await expect(assertCleanWorkspace({ root: "/tmp", run: sync })).resolves.toBeDefined()
  const dirty = async () => " M src/foo.ts\n"
  await expect(assertCleanWorkspace({ root: "/tmp", run: dirty })).rejects.toThrow("not clean")
  const version = async () => " M packages/foo/package.json\n"
  await expect(assertCleanWorkspace({ root: "/tmp", run: version })).rejects.toThrow("not clean")
  await expect(assertCleanWorkspace({ root: "/tmp", run: version, allowVersion: true })).resolves.toBeDefined()
})

test("CI release creates a release commit and pushes main", async () => {
  const calls: string[][] = []
  const run = async (args: string[]) => {
    calls.push([...args])
    const key = args.join(" ")
    if (key === "git rev-parse --abbrev-ref HEAD") return "main\n"
    if (key === "git diff --cached --name-only") return "packages/foo/package.json\n"
    if (key === "git rev-parse --short HEAD") return "abc123\n"
    return ""
  }
  const result = await triggerCi({ root: "/tmp", target: "1.2.0", stage: false, run })
  expect(result).toEqual({ commit: "abc123", message: "release: v1.2.0 [release]" })
  expect(calls.some((args) => args.join(" ") === "git commit -m release: v1.2.0 [release]")).toBe(true)
  expect(calls.some((args) => args.join(" ") === "git push origin main")).toBe(true)
  await expect(triggerCi({
    root: "/tmp",
    target: "1.2.0",
    stage: false,
    run: async (args: string[]) => args.join(" ") === "git rev-parse --abbrev-ref HEAD" ? "feature\n" : "",
  })).rejects.toThrow("requires main")
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

test("target version uses the larger of local and registry versions", async () => {
  const fx = await fixture({ latest: "1.0.10", version: "1.0.11" })
  try {
    expect((await resolveTargetVersion({ root: fx.root, fetchImpl: fx.fetchImpl, spec: "patch" })).target).toBe("1.0.12")
    fx.latestVersions.set(CHILD, "1.0.20")
    fx.latestVersions.set(UNICORN, "1.0.20")
    expect((await resolveTargetVersion({ root: fx.root, fetchImpl: fx.fetchImpl, spec: "patch" })).target).toBe("1.0.21")
    expect((await resolveTargetVersion({ root: fx.root, fetchImpl: fx.fetchImpl, spec: "minor" })).target).toBe("1.1.0")
  } finally { await fx.cleanup() }
})

test("explicit target must be strictly newer than latest and not lower than local", async () => {
  const fx = await fixture({ latest: "1.0.11", version: "1.0.11" })
  try {
    await expect(resolveTargetVersion({ root: fx.root, fetchImpl: fx.fetchImpl, spec: "1.0.11" })).rejects.toThrow("greater than registry latest")
    expect((await resolveTargetVersion({ root: fx.root, fetchImpl: fx.fetchImpl, spec: "1.0.12" })).target).toBe("1.0.12")
  } finally { await fx.cleanup() }

  const lower = await fixture({ latest: "1.0.10", version: "1.0.15" })
  try {
    await expect(resolveTargetVersion({ root: lower.root, fetchImpl: lower.fetchImpl, spec: "1.0.11" })).rejects.toThrow("lower than local")
  } finally { await lower.cleanup() }
})

test("release dry run does not check, bump or publish", async () => {
  const fx = await fixture()
  try {
    const run = async (args: string[]) => { fx.calls.push([...args]); return "" }
    const result = await release({ root: fx.root, args: ["--release-type=local-publish", "--dry-run"], run, fetchImpl: fx.fetchImpl, log: () => {} })
    expect(result).toMatchObject({ dryRun: true, releaseType: "local-publish", from: "1.0.11", to: "1.0.12" })
    expect(fx.calls.some((args) => args.join(" ") === "npm run check")).toBe(false)
  } finally { await fx.cleanup() }
})

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
