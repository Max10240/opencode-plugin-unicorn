import { expect, test } from "bun:test"
import { commandIsListed } from "./palette.js"

test("command readiness requires a result, not just the palette query", () => {
  const title = "Search previous prompts"
  expect(commandIsListed(`Commands\n> ${title}\nNo results`, title)).toBe(false)
  expect(commandIsListed(`Commands\n> ${title}\nPrompt  ${title}  f12`, title)).toBe(true)
  expect(commandIsListed("Session is ready", title)).toBe(false)
})
