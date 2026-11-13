import { expect, setDefaultTimeout, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { existsSync } from "node:fs"
import { chmod, cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

setDefaultTimeout(60_000)

const repository = fileURLToPath(new URL("../", import.meta.url))
const hasExpect = process.platform !== "win32" && (() => {
  try { return Boolean(execFileSync("sh", ["-c", "command -v expect"], { encoding: "utf8" }).trim()) } catch { return false }
})()

async function run(command: string[], { cwd, env, timeout = 20_000 }: { cwd: string; env: Record<string, string | undefined>; timeout?: number }) {
  const child = Bun.spawn(command, { cwd, env, stdout: "pipe", stderr: "pipe" })
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]).then(([stdout, stderr, code]) => ({ stdout, stderr, code })),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          try { child.kill("SIGTERM") } catch {}
          reject(new Error(`Timed out: ${command.join(" ")}`))
        }, timeout)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

async function stopSessionChildren(sessions: string) {
  try {
    for (const entry of await readdir(sessions)) {
      try {
        const directory = path.join(sessions, entry)
        const done = JSON.parse(await readFile(path.join(directory, "done.json"), "utf8"))
        if (Number.isInteger(done.code)) continue
      } catch {}
      try {
        const state = JSON.parse(await readFile(path.join(sessions, entry, "session.json"), "utf8"))
        if (Number.isInteger(state.pid)) {
          try { process.kill(-state.pid, "SIGTERM") } catch { try { process.kill(state.pid, "SIGTERM") } catch {} }
        }
      } catch {}
    }
  } catch {}
}

function commandPath(name: string) {
  return execFileSync("sh", ["-c", `command -v ${name}`], { encoding: "utf8" }).trim()
}

test("local publish pauses for login and publish auth links, then resumes to completion", async () => {
  if (!hasExpect) throw new Error("This test requires expect for resumable npm authentication")
  const work = await mkdtemp(path.join(os.tmpdir(), "release-resume-"))
  const fixture = path.join(work, "repo")
  const auth = path.join(work, "auth")
  const bin = path.join(work, "bin")
  const sessions = path.join(work, "sessions")
  await mkdir(fixture, { recursive: true })
  await mkdir(auth, { recursive: true })
  await mkdir(bin, { recursive: true })
  await mkdir(sessions, { recursive: true })
  await mkdir(path.join(fixture, "packages/unicorn"), { recursive: true })
  await mkdir(path.join(fixture, "packages/show-img"), { recursive: true })
  await mkdir(path.join(fixture, "packages/new-plugin"), { recursive: true })
  await cp(path.join(repository, "scripts"), path.join(fixture, "scripts"), { recursive: true })
  await symlink(path.join(repository, "node_modules"), path.join(fixture, "node_modules"), "dir")

  await writeFile(path.join(fixture, "package.json"), JSON.stringify({
    name: "release-fixture",
    private: true,
    version: "0.0.1",
    type: "module",
    scripts: { "check:release": "true", build: "true", release: "node scripts/release.mjs" },
  }, null, 2))
  await writeFile(path.join(fixture, ".gitignore"), "node_modules\ndist\n*.tgz\n")
  await writeFile(path.join(fixture, "packages/unicorn/package.json"), JSON.stringify({
    name: "@max10240/opencode-plugin-unicorn",
    version: "1.0.1",
    dependencies: {
      "@max10240/opencode-plugin-new-plugin": "1.0.1",
      "@max10240/opencode-plugin-show-img": "1.0.1",
    },
    scripts: { build: "true" },
  }, null, 2))
  await writeFile(path.join(fixture, "packages/unicorn/index.js"), "export default 'unicorn'\n")
  await writeFile(path.join(fixture, "packages/show-img/package.json"), JSON.stringify({
    name: "@max10240/opencode-plugin-show-img",
    version: "1.0.1",
    scripts: { build: "true" },
  }, null, 2))
  await writeFile(path.join(fixture, "packages/show-img/index.js"), "export default 'show-img'\n")
  await writeFile(path.join(fixture, "packages/new-plugin/package.json"), JSON.stringify({
    name: "@max10240/opencode-plugin-new-plugin",
    version: "1.0.1",
    scripts: { build: "true" },
  }, null, 2))
  await writeFile(path.join(fixture, "packages/new-plugin/index.js"), "export default 'new-plugin'\n")
  await writeFile(path.join(auth, "npmrc"), "")

  const fakeNpm = path.join(bin, "npm")
  await writeFile(fakeNpm, [
    "#!/bin/sh",
    "set -eu",
    'if [ "$1" = "run" ] && [ "$2" = "check:release" ]; then',
    '  echo "fixture check:release"',
    "  exit 0",
    "fi",
    'if [ "$1" = "whoami" ]; then',
    '  echo "npm error code E401" >&2',
    "  exit 1",
    "fi",
    'if [ "$1" = "login" ]; then',
    '  echo "https://www.npmjs.com/auth/cli/login-one"',
    '  while [ ! -f "$AUTH_DIR/authorized-login" ]; do sleep 1; done',
    "  exit 0",
    "fi",
    'if [ "$1" = "publish" ]; then',
    '  printf "%s\\n" "$*" >> "$AUTH_DIR/publish-order"',
    '  if [ -f "$AUTH_DIR/authorized-publish" ]; then',
    "    exit 0",
    "  fi",
    '  echo "https://www.npmjs.com/auth/cli/publish-two"',
    '  while [ ! -f "$AUTH_DIR/authorized-publish" ]; do sleep 1; done',
    "  exit 0",
    "fi",
    'exec "$REAL_NPM" "$@"',
    "",
  ].join("\n"), { mode: 0o755 })
  await chmod(fakeNpm, 0o755)

  execFileSync("git", ["init", "-q"], { cwd: fixture })
  execFileSync("git", ["config", "user.name", "Release Test"], { cwd: fixture })
  execFileSync("git", ["config", "user.email", "release@example.test"], { cwd: fixture })
  execFileSync("git", ["add", "-A"], { cwd: fixture })
  execFileSync("git", ["commit", "-qm", "fixture"], { cwd: fixture })
  expect(execFileSync("git", ["status", "--porcelain"], { cwd: fixture, encoding: "utf8" }).trim()).toBe("")

  const registryServer = Bun.serve({
    port: 0,
    fetch(request) {
      const url = new URL(request.url)
      if (url.pathname.endsWith("/latest")) return Response.json({ version: "1.0.0" })
      return new Response("not found", { status: 404 })
    },
  })
  const registry = `http://127.0.0.1:${registryServer.port}/`
  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH ?? ""}`,
    AUTH_DIR: auth,
    REAL_NPM: commandPath("npm"),
    OPENCODE_RELEASE_TMPDIR: sessions,
    npm_config_userconfig: path.join(auth, "npmrc"),
    NPM_CONFIG_USERCONFIG: path.join(auth, "npmrc"),
    npm_config_cache: path.join(auth, "npm-cache"),
    NPM_CONFIG_CACHE: path.join(auth, "npm-cache"),
    npm_config_update_notifier: "false",
    NPM_CONFIG_UPDATE_NOTIFIER: "false",
    npm_config_fund: "false",
    npm_config_audit: "false",
  }
  let id: string | undefined
  try {
    const dryRun = await run([fakeNpm, "run", "release", "--", "--release-type=local-publish", "--dry-run", `--registry=${registry}`], { cwd: fixture, env })
    const dryRunOutput = `${dryRun.stdout}\n${dryRun.stderr}`
    expect(dryRun.code).toBe(0)
    expect(dryRunOutput).toContain('"dryRun":true')
    expect(await readdir(sessions)).toHaveLength(0)
    expect(execFileSync("git", ["status", "--porcelain"], { cwd: fixture, encoding: "utf8" }).trim()).toBe("")

    const first = await run([fakeNpm, "run", "release", "--", "--release-type=local-publish", `--registry=${registry}`], { cwd: fixture, env })
    const firstOutput = `${first.stdout}\n${first.stderr}`
    expect(first.code).toBe(0)
    expect(firstOutput).toContain("Checking before publish")
    expect(firstOutput).toContain("https://www.npmjs.com/auth/cli/login-one")
    expect(firstOutput).toContain("Waiting for user to authorize")
    id = /--resume ([0-9a-f-]{36})/i.exec(firstOutput)?.[1]
    expect(id).toBeString()

    await writeFile(path.join(auth, "authorized-login"), "")
    const second = await run([fakeNpm, "run", "release", "--", "--release-type=local-publish", `--registry=${registry}`, "--resume", id!], { cwd: fixture, env })
    const secondOutput = `${second.stdout}\n${second.stderr}`
    expect(second.code).toBe(0)
    expect(secondOutput).toContain("https://www.npmjs.com/auth/cli/publish-two")
    expect(secondOutput).toContain(`--resume ${id}`)

    const sessionDir = path.join(sessions, id!)
    expect(await readFile(path.join(sessionDir, "output.log"), "utf8")).toContain("fixture check:release")
    const sessionState = JSON.parse(await readFile(path.join(sessionDir, "session.json"), "utf8"))
    expect(sessionState.args).toEqual(["--release-type=local-publish", `--registry=${registry}`])
    expect(sessionState.status).toBe("waiting-auth")
    const events = (await readFile(path.join(sessionDir, "auth-events.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
    expect(events.some((event) => event.type === "auth" && event.url.endsWith("/login-one"))).toBe(true)
    expect(events.some((event) => event.type === "auth" && event.url.endsWith("/publish-two"))).toBe(true)
    expect(events.some((event) => event.type === "resolved")).toBe(true)
    const firstPublishes = (await readFile(path.join(auth, "publish-order"), "utf8")).trim().split("\n")
    expect(firstPublishes).toHaveLength(1)
    expect(firstPublishes[0]).toContain("--workspace @max10240/opencode-plugin-new-plugin")
    expect(firstPublishes[0]).toContain("--workspace @max10240/opencode-plugin-show-img")
    expect(firstPublishes[0]).not.toContain("unicorn")

    await writeFile(path.join(auth, "authorized-publish"), "")
    const final = await run([fakeNpm, "run", "release", "--", "--release-type=local-publish", `--registry=${registry}`, "--resume", id!], { cwd: fixture, env })
    const finalOutput = `${final.stdout}\n${final.stderr}`
    expect(final.code).toBe(0)
    expect(finalOutput).toContain('"version":"1.0.2"')
    expect(finalOutput).toContain('"commit"')

    expect(execFileSync("git", ["log", "-1", "--pretty=%s"], { cwd: fixture, encoding: "utf8" }).trim())
      .toBe("release: v1.0.2 [local-publish]")
    const manifest = JSON.parse(await readFile(path.join(fixture, "packages/unicorn/package.json"), "utf8"))
    expect(manifest.version).toBe("1.0.2")
    expect(manifest.dependencies["@max10240/opencode-plugin-new-plugin"]).toBe("1.0.2")
    expect(manifest.dependencies["@max10240/opencode-plugin-show-img"]).toBe("1.0.2")

    const publishes = (await readFile(path.join(auth, "publish-order"), "utf8")).trim().split("\n")
    expect(publishes).toHaveLength(2)
    expect(publishes[1]).toContain("--workspace @max10240/opencode-plugin-unicorn")
    expect(publishes[1]).not.toContain("opencode-plugin-new-plugin")
    expect(publishes[1]).not.toContain("opencode-plugin-show-img")
    expect(existsSync(sessionDir)).toBe(false)

    const missing = await run([fakeNpm, "run", "release", "--", "--release-type=local-publish", `--registry=${registry}`, "--resume", "00000000-0000-4000-8000-000000000000"], { cwd: fixture, env })
    expect(missing.code).toBe(1)
    expect(`${missing.stdout}\n${missing.stderr}`).toContain("not found")
  } finally {
    await stopSessionChildren(sessions)
    registryServer.stop(true)
    await rm(work, { recursive: true, force: true })
  }
})
