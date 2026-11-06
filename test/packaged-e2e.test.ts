import { expect, setDefaultTimeout, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { checkPluginVersions } from "../scripts/check-versions.mjs"
import { recommendedCommands } from "../packages/opencode-plugin-recomended-opencode-config/src/index.js"
import { installArchives, packWorkspace } from "../scripts/test-artifacts.mjs"
import { installUnicornOnly } from "./unicorn-install.js"

setDefaultTimeout(360_000)

const repository = path.resolve(fileURLToPath(import.meta.url), "../..")
const packages = [
  { directory: "opencode-plugin-send-message-across-sessions", id: "max10240.send-message-across-sessions", kind: "send-message" },
  { directory: "opencode-plugin-image-gen", id: "opencode.image-gen", kind: "image-gen" },
  { directory: "opencode-plugin-notepad", id: "max10240.notepad", kind: "notepad" },
  { directory: "opencode-plugin-prompt-search", id: "max10240.prompt-search", kind: "prompt-search" },
  { directory: "opencode-plugin-session-search", id: "max10240.session-search", kind: "session-search" },
  { directory: "opencode-plugin-show-img", id: "max10240.show-img", kind: "show-img" },
  { directory: "opencode-plugin-sensitive-encrypt", id: "max10240.sensitive-encrypt", kind: "sensitive-encrypt" },
  { directory: "opencode-plugin-sensitive-protection", id: "max10240.sensitive-protection", kind: "sensitive-protection" },
  { directory: "opencode-plugin-recomended-opencode-config", id: "max10240.recomended-opencode-config", kind: "recommended-config" },
  { directory: "opencode-plugin-unicorn", id: "max10240.unicorn", kind: "unicorn" },
] as const

test("every npm tarball contains only JavaScript and resolves in an isolated install", async () => {
  const { version } = await checkPluginVersions(repository)
  const root = await mkdtemp(path.join(os.tmpdir(), "opencode-packaged-e2e-"))
  try {
    const archives = await packWorkspace(path.join(root, "artifacts"))
    for (const entry of packages) {
      const archive = archives.find((item) => path.basename(item.directory) === entry.directory)!
      const packed = [archive.packed]
      expect(packed).toHaveLength(1)
      expect(packed[0]!.version).toBe(version)
      const files = packed[0]!.files.map((item) => item.path)
      expect(files).toContain("dist/src/index.js")
      expect(files).toContain("README.md")
      expect(files).toContain("README.zh-CN.md")
      expect(files).toContain("dist/index.js")
      expect(files.some((file) => /\.(?:ts|tsx|jsx|map)$/.test(file))).toBe(false)
      expect(files.every((file) => file === "package.json" || file === "README.md" || file === "README.zh-CN.md" || file.endsWith(".js"))).toBe(true)
      expect(files.some((file) => /opencode\.jsonc?$/.test(file))).toBe(false)
      if (entry.kind === "unicorn") expect(files).not.toContain("dist/src/global-config.js")
      if (entry.kind === "unicorn" || entry.kind === "prompt-search" || entry.kind === "show-img" || entry.kind === "session-search" || entry.kind === "sensitive-encrypt" || entry.kind === "sensitive-protection" || entry.kind === "notepad") {
        expect(files).toContain("dist/tui.js")
        expect(files).toContain("dist/src/tui.js")
      }
    }

    const install = path.join(root, "install")
    await installArchives(archives, install)

    await installUnicornOnly(archives, path.join(root, "single-package"), path.join(install, "package-lock.json"))

    const importable = packages.map((entry) => ({
      directory: entry.directory,
      specifier: `@max10240/${entry.directory}`,
      id: entry.id,
      tui: ["unicorn", "prompt-search", "show-img", "session-search", "sensitive-encrypt", "sensitive-protection", "notepad"].includes(entry.kind),
    }))
    const verified = JSON.parse(run(["node", "--input-type=module", "-e", `
      const checks = JSON.parse(process.argv[1])
      const result = []
      for (const entry of checks) {
        const plugin = (await import(entry.specifier)).default
        const tui = entry.tui ? (await import(entry.specifier + "/tui")).default : undefined
        result.push({ directory: entry.directory, id: plugin?.id, tui: tui?.id })
      }
      const recommended = await import("@max10240/opencode-plugin-recomended-opencode-config")
      const setup = await import("@max10240/opencode-plugin-send-message-across-sessions/setup")
      console.log(JSON.stringify({ plugins: result, recommended: { rules: recommended.recommendedRules, commands: recommended.recommendedCommands }, setup: typeof setup.setupSendMessageAcrossSessions }))
    `, JSON.stringify(importable)], install)) as {
      plugins: Array<{ directory: string; id: string | undefined; tui: string | undefined }>
      recommended: { rules: Array<Record<string, unknown>>; commands: unknown }
      setup: string
    }
    for (const entry of packages) {
      const packageRoot = path.join(install, "node_modules", "@max10240", entry.directory)
      const manifest = JSON.parse(await readFile(path.join(packageRoot, "package.json"), "utf8")) as { version: string; exports: Record<string, string> }
      expect(manifest.version).toBe(version)
      expect(Object.values(manifest.exports).every((file) => file.startsWith("./dist/") && file.endsWith(".js"))).toBe(true)
      const imported = verified.plugins.find((item) => item.directory === entry.directory)
      expect(imported?.id).toBe(entry.id)
      if (["unicorn", "prompt-search", "show-img", "session-search", "sensitive-encrypt", "sensitive-protection", "notepad"].includes(entry.kind)) expect(imported?.tui).toBe(`${entry.id}.tui`)
    }
    expect(verified.recommended.rules.length).toBeGreaterThan(0)
    expect(verified.recommended.rules.every((rule) => typeof rule.title === "string" && !("depth" in rule))).toBe(true)
    expect(verified.recommended.commands).toEqual(recommendedCommands)
    expect(verified.setup).toBe("function")
  } finally {
    if (process.platform === "win32") await rm(root, { recursive: true, force: true })
    else Bun.spawnSync(["rm", "-rf", root], { stdout: "ignore", stderr: "ignore" })
  }
})

function run(args: string[], cwd: string) {
  const result = Bun.spawnSync(args, { cwd, stdout: "pipe", stderr: "pipe" })
  if (result.exitCode !== 0) throw new Error(`${args.join(" ")} failed (${result.exitCode}):\n${result.stdout}\n${result.stderr}`)
  return result.stdout.toString()
}
