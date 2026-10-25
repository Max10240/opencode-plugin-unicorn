import { expect, test } from "bun:test"
import { access, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { extractCommands, extractMarkdownCommand, readMarkdownCommands, syncRecommendedCommands } from "../scripts/sync-recommended-commands.mjs"

test("extracts only inline commands and never copies provider credentials or other configuration", () => {
  const value = extractCommands(`{
    // JSONC comment
    "providers": {"openai":{"apiKey":"DO_NOT_EXPORT_THIS"}},
    "commands": {"review":{"template":"Review $ARGUMENTS","description":"Review","agent":"plan","model":"openai/model","subagent":false}},
    "command": {"legacy":{"template":"Do not copy"}},
  }`)
  expect(value).toEqual({ review: { template: "Review $ARGUMENTS", description: "Review", agent: "plan", model: "openai/model", subagent: false } })
  expect(JSON.stringify(value)).not.toContain("DO_NOT_EXPORT_THIS")
  expect(extractCommands('{"commands":{}}')).toEqual({})
})

test("invalid source data fails without exporting unrelated or malformed data", () => {
  for (const text of ["{broken", "[]", '{"commands":null}', '{"commands":[]}', '{"commands":{"invalid":{}}}', '{"commands":{"invalid":{"template":"text","description":false}}}', '{"commands":{"invalid":{"__proto__":{"template":"inherited"}}}}']) {
    expect(() => extractCommands(text)).toThrow()
  }
})

test("prototype-provided fields are not treated as inline command definitions", () => {
  expect(extractCommands('{"__proto__":{"commands":{"fake":{"template":"Do not copy"}}}}')).toEqual({})
})

test("Markdown body supplies the template and only supported frontmatter fields are exported", () => {
  expect(extractMarkdownCommand(`---
description: >-
  Review changes
  carefully
agent: plan
model: openai/model#high
subagent: false
subtask: true
template: MUST_NOT_OVERRIDE_BODY
apiKey: DO_NOT_EXPORT_THIS
---

# Review

Review $ARGUMENTS and $1. !\`git diff\`
`)).toEqual({ template: "# Review\n\nReview $ARGUMENTS and $1. !`git diff`", description: "Review changes carefully", agent: "plan", model: "openai/model#high", subagent: false, subtask: true })
  expect(extractMarkdownCommand("\uFEFF---\r\ndescription: Review: correctness\r\n---\r\n\r\nReview $ARGUMENTS\r\n")).toEqual({ template: "Review $ARGUMENTS", description: "Review: correctness" })
  expect(extractMarkdownCommand("\n  Plain prompt $ARGUMENTS\n")).toEqual({ template: "Plain prompt $ARGUMENTS" })
  expect(extractMarkdownCommand("---\n---\nBody")).toEqual({ template: "Body" })
})

test("invalid or executable frontmatter fails without executing JavaScript", () => {
  for (const text of [
    "---\ndescription: missing delimiter", "---\ndescription: [broken\n---\nBody", "---\n- list\n---\nBody",
    "---\ndescription: 123\n---\nBody", '---\nsubagent: "false"\n---\nBody',
    "---\ndescription: one\ndescription: two\n---\nBody", "---\ndescription: !!js/function 'function () { return 1 }'\n---\nBody",
    "---\ndescription: {broken: value\n---\nBody", "---\ndescription: [one: two\n---\nBody",
    "---\ndescription: !custom key: value\n---\nBody",
  ]) expect(() => extractMarkdownCommand(text, "invalid")).toThrow()
  expect(extractMarkdownCommand("---\n__proto__:\n  description: INHERITED\n---\nBody")).toEqual({ template: "Body" })
})

test("YAML anchors and merge keys preserve command metadata without exporting unrelated defaults", () => {
  expect(extractMarkdownCommand(`---
defaults: &defaults
  description: Base description
  agent: plan
  subagent: false
  apiKey: DO_NOT_EXPORT_THIS
<<: *defaults
description: Explicit description
---
Review $ARGUMENTS
`)).toEqual({ template: "Review $ARGUMENTS", description: "Explicit description", agent: "plan", subagent: false })
})

test("collects nested Markdown, symlink aliases and hidden names without following cycles", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "opencode-command-directory-"))
  try {
    const directory = path.join(root, ".commands")
    await mkdir(path.join(directory, "team"), { recursive: true })
    await writeFile(path.join(directory, "team/review.md"), "---\ndescription: Team review\n---\nReview $ARGUMENTS")
    await writeFile(path.join(directory, ".hidden.md"), "Hidden prompt")
    await writeFile(path.join(directory, "ignored.txt"), "DO_NOT_EXPORT_THIS")
    await symlink("team", path.join(directory, "alias"))
    await symlink(directory, path.join(directory, "loop"))
    await symlink("missing.md", path.join(directory, "dangling.md"))
    const result = await readMarkdownCommands(directory)
    expect(result.present).toBe(true)
    expect(result.commands).toEqual({ ".hidden": { template: "Hidden prompt" }, "alias/review": { template: "Review $ARGUMENTS", description: "Team review" }, "team/review": { template: "Review $ARGUMENTS", description: "Team review" } })
    expect(await readMarkdownCommands(path.join(root, "absent"))).toEqual({ present: false, commands: {} })
  } finally { await rm(root, { recursive: true, force: true }) }
})

test("combines source directories with inline commands deterministically and never executes shell templates", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "opencode-command-sources-"))
  const source = path.join(root, "opencode.jsonc")
  const target = path.join(root, "snapshot.json")
  try {
    await writeFile(source, '{"commands":{"review":{"template":"INLINE"},"inline-only":{"template":"KEEP"}},"providers":{"secret":"DO_NOT_EXPORT_THIS"}}')
    for (const folder of [".commands", "command", "commands"]) {
      await mkdir(path.join(root, folder))
      await writeFile(path.join(root, folder, "review.md"), `---\ndescription: ${folder}\n---\n${folder} $ARGUMENTS`)
    }
    await mkdir(path.join(root, ".commands/team"))
    const template = `Do not run while syncing: !\`touch ${path.join(root, "executed")}\``
    await writeFile(path.join(root, ".commands/team/check.md"), template)
    expect(await syncRecommendedCommands({ source, target })).toBe(true)
    expect(JSON.parse(await readFile(target, "utf8"))).toEqual({ review: { template: "commands $ARGUMENTS", description: "commands", source: "markdown" }, "inline-only": { template: "KEEP" }, "team/check": { template, source: "markdown" } })
    await expect(access(path.join(root, "executed"))).rejects.toThrow()
    const before = await stat(target)
    expect(await syncRecommendedCommands({ source, target })).toBe(false)
    expect((await stat(target)).mtimeMs).toBe(before.mtimeMs)
    await rm(path.join(root, ".commands/team/check.md"))
    expect(await syncRecommendedCommands({ source, target })).toBe(true)
    expect(JSON.parse(await readFile(target, "utf8"))["team/check"]).toBeUndefined()
  } finally { await rm(root, { recursive: true, force: true }) }
})

test("directory-only sources work without JSON, explicit directories override defaults, and absent sources retain the snapshot", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "opencode-command-directory-only-"))
  const source = path.join(root, "missing.jsonc")
  const directory = path.join(root, ".commands")
  const target = path.join(root, "snapshot.json")
  try {
    await mkdir(directory)
    await writeFile(path.join(directory, "fixture.md"), "Directory $ARGUMENTS")
    expect(await syncRecommendedCommands({ source, target })).toBe(true)
    expect(JSON.parse(await readFile(target, "utf8"))).toEqual({ fixture: { template: "Directory $ARGUMENTS", source: "markdown" } })
    await writeFile(path.join(directory, "fixture.md"), "---\ndescription: [invalid\n---\nBody")
    await expect(syncRecommendedCommands({ source, target })).rejects.toThrow()
    expect(JSON.parse(await readFile(target, "utf8"))).toEqual({ fixture: { template: "Directory $ARGUMENTS", source: "markdown" } })
    await rm(path.join(directory, "fixture.md"))
    expect(await syncRecommendedCommands({ source, target })).toBe(true)
    expect(JSON.parse(await readFile(target, "utf8"))).toEqual({})
    await writeFile(path.join(directory, "fixture.md"), "DEFAULT")
    const explicit = path.join(root, "custom")
    await mkdir(explicit)
    await writeFile(path.join(explicit, "custom.md"), "EXPLICIT")
    expect(await syncRecommendedCommands({ source, target, directories: [explicit] })).toBe(true)
    expect(JSON.parse(await readFile(target, "utf8"))).toEqual({ custom: { template: "EXPLICIT", source: "markdown" } })
    await rm(explicit, { recursive: true })
    expect(await syncRecommendedCommands({ source, target, directories: [explicit] })).toBe(false)
    expect(JSON.parse(await readFile(target, "utf8"))).toEqual({ custom: { template: "EXPLICIT", source: "markdown" } })
  } finally { await rm(root, { recursive: true, force: true }) }
})

test("refreshes the partial snapshot, removes source-deleted recommendations, and retains it when source is absent", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "opencode-command-snapshot-"))
  const source = path.join(root, "opencode.jsonc")
  const target = path.join(root, "commands.json")
  try {
    await writeFile(source, '{"commands":{"fixture":{"template":"Fixture"}},"private":"DO_NOT_EXPORT_THIS"}')
    expect(await syncRecommendedCommands({ source, target })).toBe(true)
    expect(JSON.parse(await readFile(target, "utf8"))).toEqual({ fixture: { template: "Fixture" } })
    expect(await syncRecommendedCommands({ source, target })).toBe(false)
    await writeFile(source, "{broken")
    await expect(syncRecommendedCommands({ source, target })).rejects.toThrow()
    expect(JSON.parse(await readFile(target, "utf8"))).toEqual({ fixture: { template: "Fixture" } })
    await writeFile(source, "{}")
    expect(await syncRecommendedCommands({ source, target })).toBe(true)
    expect(JSON.parse(await readFile(target, "utf8"))).toEqual({})
    await rm(source)
    expect(await syncRecommendedCommands({ source, target })).toBe(false)
  } finally { await rm(root, { recursive: true, force: true }) }
})
