import { expect, setDefaultTimeout, test } from "bun:test"
import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { isolatedEnvironment, networkSandboxProfile } from "./run-image-gen-auth-parity.mjs"

setDefaultTimeout(30_000)

test("the research runner never inherits credentials, proxy settings, or live config overrides", () => {
  const environment = isolatedEnvironment("/isolated", {
    PATH: "/usr/bin:/bin", HOME: "/real-home", OPENAI_API_KEY: "DO_NOT_INHERIT", AWS_SECRET_ACCESS_KEY: "DO_NOT_INHERIT",
    GOOGLE_APPLICATION_CREDENTIALS: "/real-credentials.json", HTTPS_PROXY: "DO_NOT_INHERIT",
    OPENCODE_CONFIG: "/real-config.jsonc", OPENCODE_CONFIG_CONTENT: "DO_NOT_INHERIT", IS_MAX_SELF: "1",
  })
  expect(environment.HOME).toBe("/isolated")
  expect(environment.OPENCODE_CONFIG_DIR).toBe("/isolated/config")
  expect(JSON.stringify(environment)).not.toContain("DO_NOT_INHERIT")
  expect(environment.GOOGLE_APPLICATION_CREDENTIALS).toBeUndefined()
  expect(environment.IS_MAX_SELF).toBeUndefined()
})

test.skipIf(process.platform === "win32")("interrupting the runner kills its owned child group and removes its temporary HOME", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "opencode-research-interrupt-"))
  const record = path.join(directory, "child.json")
  const bin = path.join(directory, "bin")
  await mkdir(bin)
  const fakeBun = path.join(bin, "bun")
  await writeFile(fakeBun, `#!${process.execPath}\nimport {writeFileSync} from "node:fs";writeFileSync(${JSON.stringify(record)},JSON.stringify({pid:process.pid,home:process.env.HOME,auth:typeof process.env.OPENAI_API_KEY}));setInterval(()=>{},1000);\n`)
  await chmod(fakeBun, 0o755)
  const child = Bun.spawn(["node", fileURLToPath(new URL("./run-image-gen-auth-parity.mjs", import.meta.url))], {
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, OPENAI_API_KEY: "SYNTHETIC_MUST_NOT_INHERIT" },
    stdout: "pipe", stderr: "pipe",
  })
  const stdout = new Response(child.stdout).text()
  const stderr = new Response(child.stderr).text()
  const timer = setTimeout(() => { if (child.exitCode === null) child.kill(9) }, 10_000)
  let state: { pid: number; home: string; auth: string } | undefined
  try {
    const deadline = Date.now() + 5_000
    while (Date.now() < deadline) {
      try { state = JSON.parse(await readFile(record, "utf8")); break } catch { await Bun.sleep(20) }
    }
    expect(state).toBeDefined()
    expect(state!.auth).toBe("undefined")
    child.kill("SIGTERM")
    expect(await child.exited).toBe(143)
    await Promise.all([stdout, stderr])
    await expect(access(state!.home)).rejects.toThrow()
    expect(() => process.kill(state!.pid, 0)).toThrow()
  } finally {
    clearTimeout(timer)
    if (child.exitCode === null) child.kill(9)
    await child.exited
    if (state) {
      try { process.kill(-state.pid, "SIGKILL") } catch {}
      await rm(state.home, { recursive: true, force: true })
    }
    await rm(directory, { recursive: true, force: true })
  }
})

test.skipIf(process.platform !== "darwin")("the actual sandbox profile allows localhost and blocks external sockets", async () => {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("local") })
  const script = `
import errno, http.client, socket
connection=http.client.HTTPConnection("127.0.0.1", ${server.port}, timeout=3)
connection.request("GET", "/")
assert connection.getresponse().read()==b"local"
connection.close()
external=socket.socket()
external.settimeout(3)
try:
    external.connect(("198.51.100.1",80))
    raise AssertionError("External socket was allowed")
except PermissionError as error:
    assert error.errno in (errno.EPERM,errno.EACCES)
finally:
    external.close()
  `
  // Use the OS socket error: Bun maps sandbox EPERM to FailedToOpenSocket/ECONNREFUSED.
  const child = Bun.spawn(["/usr/bin/sandbox-exec", "-p", networkSandboxProfile, "/usr/bin/python3", "-c", script], {
    env: isolatedEnvironment("/isolated"), stdout: "pipe", stderr: "pipe",
  })
  try {
    const stderr = new Response(child.stderr).text()
    const code = await child.exited
    const error = await stderr
    if (code !== 0) throw new Error(error)
    expect(code).toBe(0)
    expect(error).toBe("")
  } finally { if (child.exitCode === null) child.kill(9); server.stop(true) }
})
