import { expect, setDefaultTimeout, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { checkPluginVersions } from "../scripts/check-versions.mjs"
import { packWorkspace } from "../scripts/test-artifacts.mjs"

setDefaultTimeout(360_000)

const repository = path.resolve(fileURLToPath(import.meta.url), "../..")
const tuiPackages = new Set(["unicorn", "prompt-search", "show-img", "session-search", "sensitive-encrypt", "sensitive-protection", "notepad", "non-blocking", "opencode-go-usage"])
const packages = [
  { directory: "opencode-plugin-send-message-across-sessions", kind: "send-message" },
  { directory: "opencode-plugin-image-gen", kind: "image-gen" },
  { directory: "opencode-plugin-notepad", kind: "notepad" },
  { directory: "opencode-plugin-prompt-search", kind: "prompt-search" },
  { directory: "opencode-plugin-session-search", kind: "session-search" },
  { directory: "opencode-plugin-non-blocking", kind: "non-blocking" },
  { directory: "opencode-plugin-show-img", kind: "show-img" },
  { directory: "opencode-plugin-opencode-go-usage", kind: "opencode-go-usage" },
  { directory: "opencode-plugin-sensitive-encrypt", kind: "sensitive-encrypt" },
  { directory: "opencode-plugin-sensitive-protection", kind: "sensitive-protection" },
  { directory: "opencode-plugin-recomended-opencode-config", kind: "recommended-config" },
  { directory: "opencode-plugin-unicorn", kind: "unicorn" },
] as const

test("every npm tarball contains only JavaScript and matches its manifest", async () => {
  const { version } = await checkPluginVersions(repository)
  const root = await mkdtemp(path.join(os.tmpdir(), "opencode-packaged-e2e-"))
  try {
    const archives = await packWorkspace(path.join(root, "artifacts"))
    expect(archives).toHaveLength(packages.length)
    for (const entry of packages) {
      const archive = archives.find((item) => path.basename(item.directory) === entry.directory)!
      const packed = archive.packed
      expect(packed.version).toBe(version)
      const files = packed.files.map((item) => item.path)
      const manifest = JSON.parse(await readFile(path.join(archive.directory, "package.json"), "utf8")) as {
        version: string
        exports: Record<string, string>
      }
      const tarballManifest = JSON.parse(run(["tar", "-xOf", archive.file, "package/package.json"], root)) as typeof manifest
      expect(tarballManifest.version).toBe(version)
      expect(tarballManifest.exports).toEqual(manifest.exports)
      for (const target of Object.values(manifest.exports)) {
        expect(files).toContain(target.replace(/^\.\//, ""))
      }
      expect(files).toContain("package.json")
      expect(files).toContain("README.md")
      expect(files).toContain("README.zh-CN.md")
      expect(files).toContain("dist/index.js")
      expect(files.some((file) => /\.(?:ts|tsx|jsx|map)$/.test(file))).toBe(false)
      expect(files.every((file) => file === "package.json" || file === "README.md" || file === "README.zh-CN.md" || file.endsWith(".js"))).toBe(true)
      expect(files.some((file) => /opencode\.jsonc?$/.test(file))).toBe(false)
      if (entry.kind === "unicorn") expect(files).not.toContain("dist/src/global-config.js")
      if (tuiPackages.has(entry.kind)) {
        expect(files).toContain("dist/tui.js")
        expect(files).toContain("dist/src/tui.js")
      }
    }
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
