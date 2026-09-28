import { expect, setDefaultTimeout, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { createOpenCodeE2E, DEFAULT_LOW_LIMIT } from "../packages/opencode-plugin-unicorn/test/e2e-utils.js"

setDefaultTimeout(240_000)

const repository = path.resolve(fileURLToPath(import.meta.url), "../..")
const packages = [
  { directory: "opencode-plugin-send-message-across-sessions", id: "max10240.send-message-across-sessions", kind: "send-message" },
  { directory: "opencode-plugin-image-gen", id: "opencode.image-gen", kind: "image-gen" },
  { directory: "opencode-plugin-prompt-search", id: "max10240.prompt-search", kind: "prompt-search" },
  { directory: "opencode-plugin-unicorn", id: "max10240.unicorn", kind: "unicorn" },
] as const

test("every npm tarball contains only JavaScript and runs in isolated real OpenCode", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "opencode-packaged-e2e-"))
  try {
    run(["bun", "run", "build"], repository)
    const archives: string[] = []
    for (const entry of packages) {
      const output = run(["npm", "pack", "--json", "--pack-destination", root], path.join(repository, "packages", entry.directory))
      const packed = JSON.parse(output) as Array<{ filename: string; files: Array<{ path: string }> }>
      expect(packed).toHaveLength(1)
      const files = packed[0]!.files.map((item) => item.path)
      expect(files).toContain("dist/src/index.js")
      expect(files).toContain("dist/index.js")
      expect(files.some((file) => /\.(?:ts|tsx|jsx|map)$/.test(file))).toBe(false)
      expect(files.every((file) => file === "package.json" || file === "README.md" || file.endsWith(".js"))).toBe(true)
      if (entry.kind === "unicorn" || entry.kind === "prompt-search") {
        expect(files).toContain("dist/tui.js")
        expect(files).toContain("dist/src/tui.js")
      }
      archives.push(path.join(root, packed[0]!.filename))
    }

    const install = path.join(root, "install")
    run(["npm", "install", "--prefix", install, "--ignore-scripts", "--no-audit", "--no-fund", ...archives], root)

    for (const entry of packages) {
      const packageRoot = path.join(install, "node_modules", "@max10240", entry.directory)
      const manifest = JSON.parse(await readFile(path.join(packageRoot, "package.json"), "utf8")) as { exports: Record<string, string> }
      expect(Object.values(manifest.exports).every((file) => file.startsWith("./dist/") && file.endsWith(".js"))).toBe(true)
      expect(importWithNode(`@max10240/${entry.directory}`, install)).toBe(entry.id)
      if (entry.kind === "unicorn" || entry.kind === "prompt-search") {
        expect(importWithNode(`@max10240/${entry.directory}/tui`, install)).toBe(`${entry.id}.tui`)
      }
      if (entry.kind === "send-message") {
        expect(run(["node", "--input-type=module", "-e", "const plugin = await import(process.argv[1]); console.log(typeof plugin.setupSendMessageAcrossSessions)", `@max10240/${entry.directory}/setup`], install).trim()).toBe("function")
      }

      const e2e = await createOpenCodeE2E({
        plugin: entry.kind,
        pluginPackage: path.join(packageRoot, "dist"),
        ...(entry.kind === "unicorn" || entry.kind === "prompt-search" ? { pluginOptions: { keybind: "f12" } } : {}),
      })
      try {
        await waitFor(async () => {
          const response = await fetch(`${e2e.baseURL}/api/plugin`, { headers: authorization() })
          const plugins = (await response.json()) as { data: Array<{ id: string; state: { status: string } }> }
          const plugin = plugins.data.find((candidate) => candidate.id === entry.id)
          if (plugin?.state.status === "failed") throw new Error(`${entry.id} failed: ${JSON.stringify(plugin.state)}`)
          return plugin?.state.status === "active"
        }, `${entry.id} did not activate`)

        if (entry.kind === "unicorn") {
          expect((await e2e.waitForModelContext(1_000_000)).limit.context).toBe(1_000_000)
          const result = await e2e.runImagePrompt()
          expect(result.messages.some((message) => message.type === "user" && message.text === "E2E_IMAGE_GEN")).toBe(true)
          expect(e2e.proxy.imageRequests).toBe(1)
        } else if (entry.kind === "image-gen") {
          await e2e.waitForModelContext(DEFAULT_LOW_LIMIT.context)
          await e2e.runImagePrompt()
          expect(e2e.proxy.imageRequests).toBe(1)
        } else if (entry.kind === "send-message") {
          await e2e.runImagePrompt()
          expect(e2e.proxy.requests.some((request) => request.tools.includes("send_message_across_sessions") && request.tools.includes("list_online_sessions"))).toBe(true)
        }

        if (entry.kind === "unicorn" || entry.kind === "prompt-search") await checkTUI(e2e, entry.id)
      } finally {
        await e2e.close()
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

async function checkTUI(e2e: Awaited<ReturnType<typeof createOpenCodeE2E>>, pluginID: string) {
  if (Bun.spawnSync(["tmux", "-V"]).exitCode !== 0) throw new Error("tmux is required for packaged TUI E2E")
  const configured = (await e2e.config()).plugins[0] as { package: string }
  await writeFile(path.join(e2e.configDirectory, "cli.json"), `${JSON.stringify({ plugins: [{ package: configured.package, options: { keybind: "f12" } }] })}\n`)
  const created = await fetch(`${e2e.baseURL}/api/session`, {
    method: "POST",
    headers: { ...authorization(), "content-type": "application/json" },
    body: JSON.stringify({
      title: "Packaged-E2E",
      location: { directory: e2e.workspace },
      agent: "compaction-e2e",
      model: { providerID: "openai", id: "gpt-5.6-luna" },
    }),
    signal: AbortSignal.timeout(15_000),
  })
  if (!created.ok) throw new Error(`Could not create TUI session: ${created.status} ${await created.text()}`)
  const session = (await created.json()) as { data: { id: string } }
  for (const text of ["PACKAGED_ALPHA_123", "PACKAGED_BETA_456"]) {
    const prompt = await fetch(`${e2e.baseURL}/api/session/${session.data.id}/prompt`, {
      method: "POST",
      headers: { ...authorization(), "content-type": "application/json" },
      body: JSON.stringify({ text, delivery: "queue" }),
      signal: AbortSignal.timeout(15_000),
    })
    if (!prompt.ok) throw new Error(`Could not create TUI prompt: ${prompt.status} ${await prompt.text()}`)
    const completed = await fetch(`${e2e.baseURL}/api/experimental/session/${session.data.id}/wait`, {
      method: "POST",
      headers: authorization(),
      signal: AbortSignal.timeout(30_000),
    })
    if (!completed.ok) throw new Error(`TUI prompt failed: ${completed.status} ${await completed.text()}`)
  }
  const socket = `packaged-${pluginID.replaceAll(".", "-")}-${process.pid}`
  const target = "plugin"
  const binary = process.env.OPENCODE_BIN ?? "opencode"
  const env = {
    PATH: process.env.PATH ?? "/usr/bin:/bin:/opt/homebrew/bin",
    TERM: "xterm-256color",
    HOME: e2e.root,
    OPENCODE_CONFIG_DIR: e2e.configDirectory,
    OPENCODE_CONFIG_PROJECT_DISABLE: "1",
    OPENCODE_DB: path.join(e2e.root, "opencode.db"),
    OPENCODE_DISABLE_MODELS_FETCH: "1",
    OPENCODE_PASSWORD: "opencode-plugin-unicorn-e2e",
    XDG_CONFIG_HOME: path.join(e2e.root, "xdg-config"),
    XDG_DATA_HOME: path.join(e2e.root, "xdg-data"),
    XDG_CACHE_HOME: path.join(e2e.root, "xdg-cache"),
    XDG_STATE_HOME: path.join(e2e.root, "xdg-state"),
  }
  const command = [
    `cd ${quote(e2e.workspace)} && env -i`,
    ...Object.entries(env).map(([key, value]) => `${key}=${quote(value)}`),
    [binary, "--server", e2e.baseURL, "--session", session.data.id].map(quote).join(" "),
  ].join(" ")
  const tmux = (args: string[]) => {
    const result = Bun.spawnSync(["tmux", "-L", socket, "-f", "/dev/null", ...args], { stdout: "pipe", stderr: "pipe" })
    if (result.exitCode !== 0) throw new Error(`tmux ${args[0]} failed: ${result.stderr.toString()}`)
    return result.stdout.toString()
  }
  try {
    tmux(["new-session", "-d", "-s", target, "-x", "120", "-y", "35", command])
    await waitFor(async () => tmux(["capture-pane", "-pt", target]).includes("Packaged-E2E"), `${pluginID} TUI did not start`)
    tmux(["send-keys", "-t", target, "F12"])
    await waitFor(async () => tmux(["capture-pane", "-pt", target]).includes("Search previous prompts"), `${pluginID} prompt search dialog did not open`)
    await waitFor(async () => tmux(["capture-pane", "-pt", target]).includes("PACKAGED_BETA_456"), `${pluginID} did not index prompts`)
    tmux(["send-keys", "-t", target, "PACKAGED_ALPHA"])
    await waitFor(async () => {
      const pane = tmux(["capture-pane", "-pt", target])
      return pane.includes("PACKAGED_ALPHA_123") && !pane.includes("PACKAGED_BETA_456")
    }, `${pluginID} did not reactively filter prompts`)
    expect(tmux(["capture-pane", "-pt", target])).not.toContain("plugin failed")
  } catch (error) {
    const log = await readFile(path.join(e2e.root, "xdg-data/opencode/log/opencode.log"), "utf8").catch(() => "")
    const pane = tmux(["capture-pane", "-pt", target])
    throw new Error(`${error instanceof Error ? error.message : String(error)}\n--- TUI ---\n${pane}\n--- log ---\n${log.split("\n").filter((line) => /plugin operation failed|Cannot find|role=cli/.test(line)).slice(-15).join("\n")}`)
  } finally {
    Bun.spawnSync(["tmux", "-L", socket, "kill-server"], { stdout: "pipe", stderr: "pipe" })
  }
}

function run(args: string[], cwd: string) {
  const result = Bun.spawnSync(args, { cwd, stdout: "pipe", stderr: "pipe" })
  if (result.exitCode !== 0) throw new Error(`${args.join(" ")} failed (${result.exitCode}):\n${result.stdout}\n${result.stderr}`)
  return result.stdout.toString()
}

function importWithNode(specifier: string, cwd: string) {
  return run(["node", "--input-type=module", "-e", "const plugin = await import(process.argv[1]); console.log(plugin.default.id)", specifier], cwd).trim()
}

function authorization() {
  return { authorization: `Basic ${btoa("opencode:opencode-plugin-unicorn-e2e")}` }
}

async function waitFor(check: () => Promise<boolean>, message: string, timeout = 30_000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (await check()) return
    await Bun.sleep(100)
  }
  throw new Error(message)
}

function quote(value: string) {
  return `'${value.replaceAll("'", "'\\''")}'`
}
