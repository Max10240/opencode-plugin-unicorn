import { expect, setDefaultTimeout, test } from "bun:test"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { createOpenCodeE2E } from "../../opencode-plugin-unicorn/test/e2e-utils.js"
import { api, checkGeneratedImagePreview, waitFor } from "../../opencode-plugin-show-img/test/e2e-utils.js"

setDefaultTimeout(180_000)

for (const mode of ["image-gen-only", "image-gen-first", "show-img-first", "show-img-disabled", "unicorn", "unicorn-no-preview", "broken-preview"] as const) {
  test(`${mode}: generate/edit save successfully with optional, failure-tolerant show_img previews`, async () => {
    const combined = mode === "unicorn" || mode === "unicorn-no-preview"
    const enabled = mode === "image-gen-first" || mode === "show-img-first" || mode === "unicorn"
    const e2e = await createOpenCodeE2E({
      plugin: combined ? "unicorn" : "image-gen",
      pluginPackage: path.resolve(import.meta.dir, combined ? "../../opencode-plugin-unicorn/dist" : "../dist"),
      pluginOptions: {
        ...(mode === "show-img-first" ? { model: "openai/gpt-image-2.5-flare" } : {}),
        features: { recommendedOpencodeConfig: false, promptSearch: false, showImg: enabled },
      },
    })
    const previewCalls = path.join(e2e.root, "preview-calls.txt")
    try {
      if (!combined && mode !== "image-gen-only") {
        const config = await e2e.config()
        let companion = path.resolve(import.meta.dir, "../../opencode-plugin-show-img/dist")
        if (mode === "broken-preview") {
          companion = path.join(e2e.root, "broken-preview")
          await mkdir(companion)
          await writeFile(path.join(companion, "index.js"), `
            import { appendFile } from "node:fs/promises"
            export default { id: "e2e.broken-preview", async setup(context) {
              const registration = await context.tool.transform((editor) => {
              editor.add({ name: "show_img", options: { codemode: false }, description: "Broken preview fixture",
                input: { type: "object", properties: { abs_file_path: { type: "string" } }, required: ["abs_file_path"] },
                execute: async (input) => {
                  await appendFile(${JSON.stringify(previewCalls)}, input.abs_file_path + "\\n")
                  throw new Error("Preview failed")
                } })
              })
              return () => registration.dispose()
            } }
          `)
        }
        const preview = { package: companion, options: { features: { showImg: mode !== "show-img-disabled" } } }
        config.plugins = mode === "show-img-first" ? [preview, ...config.plugins] : [...config.plugins, preview]
        await writeFile(e2e.configPath, JSON.stringify(config))
        await waitFor(async () => {
          const plugins = await api<{ data: Array<{ id: string; state: { status: string } }> }>(e2e, `/api/plugin?${new URLSearchParams({ directory: e2e.workspace })}`)
          const companion = plugins.data.find((entry) => entry.id === (mode === "broken-preview" ? "e2e.broken-preview" : "max10240.show-img"))
          if (companion?.state.status === "failed") throw new Error(`Companion fixture failed: ${JSON.stringify(companion.state)}`)
          return companion?.state.status === "active"
        }, "Companion plugin did not activate")
      }
      await checkGeneratedImagePreview(e2e, enabled, mode === "image-gen-first" || mode === "unicorn", mode === "show-img-first" ? "gpt-image-2.5-flare" : "gpt-image-2.5-sunburst")
      expect(e2e.proxy.requests.some((request) => request.tools.includes("show_img"))).toBe(enabled || mode === "broken-preview")
      if (mode === "broken-preview") {
        const calls = (await readFile(previewCalls, "utf8")).trim().split("\n")
        expect(calls).toHaveLength(3)
        expect(calls.map((file) => path.basename(file))).toEqual(["e2e-image.png", "e2e-image-v2.png", "e2e-edit.png"])
      }
    } finally { await e2e.close() }
  })
}
