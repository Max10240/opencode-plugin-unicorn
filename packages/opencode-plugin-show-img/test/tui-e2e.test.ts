import { expect, setDefaultTimeout, test } from "bun:test"
import { writeFile } from "node:fs/promises"
import path from "node:path"
import { createOpenCodeE2E } from "../../opencode-plugin-unicorn/test/e2e-utils.js"
import { createTui } from "../../../test/tui-support.js"
import { createSession, showImages } from "./e2e-utils.js"
import { rasterFixtures } from "./fixtures.js"

setDefaultTimeout(180_000)

const PACKAGE_ROOT = path.resolve(import.meta.dir, "../../opencode-plugin-unicorn")
const features = {
  recommendedOpencodeConfig: false,
  imageGen: false,
  promptSearch: false,
  sessionSearch: false,
  notepad: false,
  sensitiveEncrypt: false,
  sensitiveProtection: false,
  infiniteLoop: false,
  delayedQueue: false,
  nonBlocking: false,
  showImg: true,
}

test.serial("show_img opens a multi-image gallery and switches with arrow keys", async () => {
  if (Bun.spawnSync(["tmux", "-V"]).exitCode !== 0) throw new Error("tmux is required for this E2E test")
  const e2e = await createOpenCodeE2E({
    plugin: "unicorn",
    pluginPackage: PACKAGE_ROOT,
    pluginOptions: { features },
  })
  try {
    await writeFile(path.join(e2e.configDirectory, "cli.json"), `${JSON.stringify({
      plugins: [{ package: PACKAGE_ROOT, options: { features } }],
    }, null, 2)}\n`)
    const sessionID = await createSession(e2e, "Show-Img-Multi")
    const files = rasterFixtures.slice(0, 2).map((fixture) => path.join(e2e.workspace, `multi-${fixture.kind}.png`))
    await Promise.all(files.map((file, index) => writeFile(file, rasterFixtures[index]!.bytes)))
    const part = await showImages(e2e, sessionID, files)
    expect(part.state.status).toBe("completed")
    expect(part.state.metadata.imagePreviews).toHaveLength(2)

    const tui = createTui(e2e, sessionID, "show-img-multi", { width: 160, height: 48 })
    try {
      await tui.waitFor("Show-Img-Multi", "the TUI did not start")
      await tui.waitFor("Image preview: multi-png.png", "the multi-image preview did not render")
      await tui.waitFor("1 of 2", "the preview did not report both images")

      const lines = tui.pane().split("\n")
      const row = lines.findIndex((line) => line.includes("Image preview: multi-png.png"))
      expect(row).toBeGreaterThanOrEqual(0)
      const column = lines[row]!.indexOf("Image preview: multi-png.png") + 1
      tui.send(["-l", `\x1b[<0;${column};${row + 1}M\x1b[<0;${column};${row + 1}m`])
      await tui.waitFor("1/2", "the gallery did not open")

      tui.send(["Right"])
      await tui.waitFor("multi-jpeg.png", "Right did not advance to the second image")
      await tui.waitFor("2/2", "the gallery did not show the second image")

      tui.send(["Left"])
      await tui.waitFor("multi-png.png", "Left did not return to the first image")
      await tui.waitFor("1/2", "the gallery did not return to the first image")

      tui.send(["Escape"])
      await tui.waitUntil(() => !tui.pane().includes("1/2"), "Escape did not close the gallery")

      const bodies = JSON.stringify(e2e.proxy.mock.getRequests().map((request) => request.body))
      for (const fixture of rasterFixtures) expect(bodies).not.toContain(fixture.bytes.toString("base64"))
    } finally {
      tui.close()
    }
  } finally {
    await e2e.close()
  }
})
