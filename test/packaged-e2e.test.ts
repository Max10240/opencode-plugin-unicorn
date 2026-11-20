import { expect, setDefaultTimeout, test } from "bun:test"
import { access, mkdtemp, readFile, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { checkPluginVersions } from "../scripts/check-versions.mjs"
import { installArchives, packWorkspace } from "../scripts/test-artifacts.mjs"
import { createOpenCodeE2E } from "../packages/opencode-plugin-unicorn/test/e2e-utils.js"

setDefaultTimeout(360_000)

const repository = path.resolve(fileURLToPath(import.meta.url), "../..")
const tuiPackages = new Set(["unicorn", "prompt-search", "show-img", "session-search", "sensitive-encrypt", "sensitive-protection", "notepad", "non-blocking", "opencode-go-usage", "infinite-loop"])
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
  { directory: "opencode-plugin-infinite-loop", kind: "infinite-loop" },
  { directory: "opencode-plugin-god", kind: "god" },
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
      const internal = {
        "prompt-search": ["dist/src/ui.js", "dist/src/query.js"],
        "session-search": ["dist/src/ui.js", "dist/src/query.js"],
        unicorn: ["dist/src/status-dialog.js", "dist/src/status-rpc.js", "dist/src/status.js"],
        "recommended-config": ["dist/src/tui.js", "dist/src/rpc.js", "dist/src/options.js"],
      } as const
      for (const file of internal[entry.kind as keyof typeof internal] ?? []) expect(files).toContain(file)
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

test("packaged install omits host-provided modules and embeds image-gen's AI runtime", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "opencode-packaged-install-"))
  try {
    const archives = await packWorkspace(path.join(root, "artifacts"))
    const install = path.join(root, "install")
    await installArchives(archives, install, { fresh: true })
    const modules = path.join(install, "node_modules")

    for (const name of ["@opencode", "@opentui", "effect", "typescript"]) {
      await expect(access(path.join(modules, name))).rejects.toThrow()
    }

    const bundle = await readFile(
      path.join(modules, "@max10240/opencode-plugin-image-gen/dist/src/index.js"),
      "utf8",
    )
    expect(bundle).not.toMatch(/from\s*["']@opencode\/ai(?:[/"'])/)
    expect(bundle).not.toMatch(/require\(\s*["']@opencode\/ai(?:[/"'])/)
    expect(bundle).not.toMatch(/import\(\s*["']@opencode\/ai(?:[/"'])/)
  } finally {
    if (process.platform === "win32") await rm(root, { recursive: true, force: true })
    else Bun.spawnSync(["rm", "-rf", root], { stdout: "ignore", stderr: "ignore" })
  }
})

test("packaged image-gen resolves host modules from OpenCode and still generates an image", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "opencode-packaged-runtime-"))
  try {
    const archives = await packWorkspace(path.join(root, "artifacts"))
    const install = path.join(root, "install")
    await installArchives(archives, install, { fresh: true })
    const e2e = await createOpenCodeE2E({
      plugin: "image-gen",
      pluginPackage: path.join(install, "node_modules/@max10240/opencode-plugin-image-gen"),
    })
    try {
      await e2e.runImagePrompt()
      expect(e2e.proxy.imageRequests).toBe(1)
      const image = await readFile(path.join(e2e.workspace, "e2e-image.png"))
      expect(image.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    } finally {
      await e2e.close()
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
