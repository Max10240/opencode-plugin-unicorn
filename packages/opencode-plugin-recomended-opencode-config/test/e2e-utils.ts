import { expect } from "bun:test"
import { readFile, stat } from "node:fs/promises"
import path from "node:path"
import { api, createSession, prompt, waitFor, type E2E } from "../../opencode-plugin-show-img/test/e2e-utils.js"
import { recommendedCommands, recommendedRules } from "../src/index.js"
import { parseRules, RULES_HEADING } from "../src/rules.js"

export async function checkRecommendedConfig(e2e: E2E) {
  const file = path.join(e2e.configDirectory, "AGENTS.md")
  // Server plugins activate lazily for a location, not merely when /api/info is healthy.
  await e2e.waitForModelContext(200_000)
  try {
    await waitFor(async () => (await e2e.config()).providers.openai.settings.store === false, "Recommended config did not disable OpenAI storage")
  } catch (error) {
    const plugins = await api(e2e, `/api/plugin?${new URLSearchParams({ directory: e2e.workspace })}`)
    const log = await readFile(path.join(e2e.root, "xdg-data/opencode/log/opencode.log"), "utf8").catch(() => "")
    throw new Error(`${error}\n${JSON.stringify(plugins)}\n${log.split("\n").filter((line) => /failed|skipped|recomended/.test(line)).slice(-12).join("\n")}`)
  }
  const text = await readFile(file, "utf8")
  expect(text).toContain(`## ${RULES_HEADING}`)
  expect(text).toContain("Keep user instructions")
  const titles = parseRules(text).map((rule) => rule.title)
  for (const rule of recommendedRules) expect(titles.filter((title) => title === rule.title)).toHaveLength(1)
  expect((await e2e.config()).share).toBe("manual")
  const commands = (await e2e.config()).commands
  const protectedName = Object.keys(recommendedCommands)[0]
  expect(commands[protectedName]).toEqual({ template: "USER_COMMAND_TEMPLATE" })
  expect(commands["user-only-command"]).toEqual({ template: "USER_ONLY" })
  for (const [name, command] of Object.entries(recommendedCommands)) {
    if (name !== protectedName) expect(commands[name]).toEqual(command)
  }
  await waitFor(async () => {
    const listed = await api<{ data: Array<{ name: string }> }>(e2e, `/api/command?${new URLSearchParams({ directory: e2e.workspace })}`)
    return Object.keys(recommendedCommands).every((name) => listed.data.some((command) => command.name === name))
  }, "Recommended inline commands were not discovered by OpenCode")
  expect((await e2e.model()).limit.context).toBe(200_000)

  const sessionID = await createSession(e2e)
  await prompt(e2e, sessionID, "E2E_RECOMMENDED_RULES")
  const requests = e2e.proxy.mock.getRequests().filter((request) => request.path.endsWith("/chat/completions"))
  expect(requests).not.toHaveLength(0)
  expect(requests.some((request) => (request.body as Record<string, unknown>)?.store === false)).toBe(true)
  const outgoing = JSON.stringify(requests.map((request) => request.body))
  expect(outgoing).toContain(RULES_HEADING)
  for (const rule of recommendedRules) expect(outgoing).toContain(rule.title)

  const beforeRules = await stat(file)
  const beforeConfig = await stat(e2e.configPath)
  await e2e.restart()
  await waitFor(async () => (await e2e.model().catch(() => undefined))?.limit.context === 200_000, "Restarted OpenCode model did not activate")
  expect(await readFile(file, "utf8")).toBe(text)
  expect((await stat(file)).mtimeMs).toBe(beforeRules.mtimeMs)
  expect((await stat(e2e.configPath)).mtimeMs).toBe(beforeConfig.mtimeMs)
}
