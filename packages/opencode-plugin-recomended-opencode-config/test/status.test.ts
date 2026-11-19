import { expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { recommendedStatus } from "../src/status.js"
import { recommendedCommands, recommendedRules } from "../src/snapshot.js"

test("reports present and missing recommended rules and commands", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "recommended-status-"))
  try {
    const rule = recommendedRules[0]!
    const command = Object.keys(recommendedCommands)[0]!
    await writeFile(path.join(directory, "AGENTS.md"), `# Personal\n\n## ${rule.title}\n\nKeep me.\n`)
    await writeFile(path.join(directory, "opencode.json"), JSON.stringify({ commands: { [command]: { template: "x" } } }))

    const status = await recommendedStatus(directory, true)
    expect(status.directory).toBe(directory)
    expect(status.enabled).toBe(true)
    expect(status.configFiles).toEqual([path.join(directory, "opencode.json")])
    expect(status.rules.present).toBe(1)
    expect(status.rules.missing).not.toContain(rule.title)
    expect(status.commands.present).toContain(command)
    expect(status.commands.missing).not.toContain(command)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
