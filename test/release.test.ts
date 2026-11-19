import { expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {
  assertCleanWorkspace,
  assertReleaseVersion,
  bumpVersion,
  compareVersions,
  fetchRegistryVersion,
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
  waitForRegistry,
} from "../scripts/release.mjs"
import { workspacePackages } from "../scripts/workspace.mjs"

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

test("registry reads can bypass a cached version response", async () => {
  const urls: string[] = []
  const remote = await fetchRegistryVersion("https://registry.npmjs.org/", CHILD, "1.0.12", {
    cacheBust: true,
    fetchImpl: async (url) => {
      urls.push(String(url))
      return Response.json({ dist: { integrity: "sha512-ok" } })
    },
  })
  expect(remote).toMatchObject({ integrity: "sha512-ok" })
  expect(urls[0]).toContain("__release=")
})

test("registry version lookup falls back to the package document", async () => {
  const calls: string[] = []
  const remote = await fetchRegistryVersion("https://registry.npmjs.org/", CHILD, "1.0.12", {
    cacheBust: true,
    fetchImpl: async (url) => {
      calls.push(String(url))
      if (String(url).includes("/1.0.12")) return new Response("not found", { status: 404 })
      return Response.json({
        versions: {
          "1.0.12": { dist: { integrity: "sha512-packument", tarball: "https://example.test/x.tgz" } },
        },
      })
    },
  })
  expect(remote).toEqual({ integrity: "sha512-packument", tarball: "https://example.test/x.tgz" })
  expect(calls).toHaveLength(2)
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

test("bump version updates every package and internal dependency", async () => {
  const fx = await fixture()
  try {
    await bumpVersion({ root: fx.root, target: "1.2.3" })
    const packages = await workspacePackages(fx.root)
    expect(packages.map((item) => item.manifest.version)).toEqual(["1.2.3", "1.2.3"])
    expect(packages.find((item) => item.manifest.name === UNICORN)?.manifest.dependencies[CHILD]).toBe("1.2.3")
  } finally { await fx.cleanup() }
})

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

test("registry verification retries transient network failures", async () => {
  let calls = 0
  const remote = await waitForRegistry("https://registry.npmjs.org/", CHILD, "1.0.12", {
    attempts: 2,
    delay: 1,
    log: () => {},
    fetchImpl: async () => {
      calls++
      if (calls === 1) throw new TypeError("fetch failed")
      return Response.json({ dist: { integrity: "sha512-ok" } })
    },
  })
  expect(remote).toMatchObject({ integrity: "sha512-ok" })
  expect(calls).toBe(2)
})

test("a current version is allowed only for idempotent CI reruns", async () => {
  const fx = await fixture({ latest: "1.0.11", version: "1.0.11" })
  try {
    await expect(assertReleaseVersion({ root: fx.root, fetchImpl: fx.fetchImpl })).rejects.toThrow("not newer")
    await expect(assertReleaseVersion({ root: fx.root, fetchImpl: fx.fetchImpl, allowCurrent: true })).resolves.toMatchObject({ version: "1.0.11" })
  } finally { await fx.cleanup() }

  const older = await fixture({ latest: "1.0.12", version: "1.0.11" })
  try {
    await expect(assertReleaseVersion({ root: older.root, fetchImpl: older.fetchImpl, allowCurrent: true })).rejects.toThrow("not newer")
  } finally { await older.cleanup() }
})

test("an idempotent CI rerun skips packages already present at the current version", async () => {
  const fx = await fixture({ latest: "1.0.11", version: "1.0.11" })
  try {
    for (const name of [CHILD, UNICORN]) fx.versions.set(`${name}@1.0.11`, { integrity: `sha512-${name}` })
    const result = await releasePackages({
      root: fx.root,
      build: false,
      verify: false,
      fetchImpl: fx.fetchImpl,
      pack: fx.pack,
      run: fx.run,
      log: () => {},
      allowCurrent: true,
    })
    expect(result).toMatchObject({ version: "1.0.11", published: [], skipped: [CHILD, UNICORN] })
    expect(fx.calls.some((args) => args[0] === "npm" && args[1] === "publish")).toBe(false)
  } finally { await fx.cleanup() }
})

test("local publish verifies dependency levels and commits package versions", async () => {
  const fx = await fixture()
  try {
    const calls: string[][] = []
    const run = async (args: string[]) => {
      calls.push([...args])
      const command = args.join(" ")
      if (command === "git diff --cached --name-only") return "packages/child/package.json\npackages/unicorn/package.json\n"
      if (command === "git rev-parse --short HEAD") return "abc123\n"
      return ""
    }
    const result = await release({
      root: fx.root,
      args: ["--release-type=local-publish"],
      run,
      fetchImpl: fx.fetchImpl,
      pack: fx.pack,
      authRun: async (args: string[]) => { calls.push([...args]); return "" },
      build: false,
      log: () => {},
    })
    expect(result).toMatchObject({ version: "1.0.12", commit: "abc123", message: "release: v1.0.12 [local-publish]" })
    const publish = calls.findIndex((args) => args[0] === "npm" && args[1] === "publish")
    const commit = calls.findIndex((args) => args[0] === "git" && args[1] === "commit")
    expect(publish).toBeGreaterThanOrEqual(0)
    expect(commit).toBeGreaterThan(publish)
    expect(calls[commit]).toEqual(["git", "commit", "-m", "release: v1.0.12 [local-publish]"])
    expect(calls.some((args) => args[0] === "npm" && args[1] === "publish" && args[2] === "--workspace")).toBe(true)
  } finally { await fx.cleanup() }
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

test("plan refuses the same version with different content unless it is an idempotent rerun", async () => {
  const fx = await fixture()
  try {
    fx.versions.set(`${CHILD}@1.0.11`, { integrity: "sha512-different" })
    await expect(planRelease({ root: fx.root, fetchImpl: fx.fetchImpl, pack: fx.pack, run: fx.run })).rejects.toThrow("differs")
    const planned = await planRelease({
      root: fx.root,
      fetchImpl: fx.fetchImpl,
      pack: fx.pack,
      run: fx.run,
      allowCurrent: true,
      log: () => {},
    })
    expect(planned.plan.find((item) => item.name === CHILD)?.action).toBe("skip")
    await planned.cleanup()
  } finally { await fx.cleanup() }
})

test("release publishes dependency levels in order and never bumps versions", async () => {
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
    expect(publishes[0]).toEqual(expect.arrayContaining([
      "npm", "publish", "--workspace", CHILD,
      "--access", "public", "--ignore-scripts", "--tag=latest",
    ]))
    expect(publishes[0]).not.toContain(UNICORN)
    expect(publishes[1]).toEqual(expect.arrayContaining([
      "npm", "publish", "--workspace", UNICORN,
      "--access", "public", "--ignore-scripts", "--tag=latest",
    ]))
    expect(publishes[1]).not.toContain(CHILD)
    expect(fx.calls.some((args) => args.includes("version"))).toBe(false)
  } finally { await fx.cleanup() }
})

test("a web-auth CLI error does not fail a package the registry accepted", async () => {
  const fx = await fixture()
  try {
    const result = await releasePackages({
      root: fx.root,
      build: false,
      verify: false,
      fetchImpl: fx.fetchImpl,
      pack: fx.pack,
      run: fx.run,
      authRun: async () => {
        for (const name of [CHILD, UNICORN]) fx.versions.set(`${name}@1.0.11`, { integrity: `sha512-${name}` })
        throw new Error("npm error 404 Not Found - GET /-/v1/done")
      },
      log: () => {},
    })
    expect(result).toMatchObject({ version: "1.0.11", published: [CHILD, UNICORN] })
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
