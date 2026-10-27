import { expect, test } from "bun:test"
import { mergeRules, parseRules, RULES_HEADING } from "../src/rules.js"

test("excludes the recommended rules container from parsed rules", () => {
  expect(parseRules(`## ${RULES_HEADING}\n\n### Rule\n\nBody\n`)).toEqual([{ title: "Rule", description: "Body" }])
})

test("parses level-free titles and preserves Markdown descriptions without treating code as headings", () => {
  expect(parseRules("### **First** ###\n\n- one\n\n```sh\n# not a title\n```\n\nSecond\n------\n\nBody\n")).toEqual([
    { title: "First", description: "- one\n\n```sh\n# not a title\n```" },
    { title: "Second", description: "Body" },
  ])
})

for (const depth of [1, 2, 3, 4, 5]) {
  test(`uses the highest existing level ${depth} for the container and nests new rules below it`, () => {
    const original = `${"#".repeat(depth)} Existing\n\nKeep me\n\n${"#".repeat(Math.min(depth + 1, 6))} Child\n\nKeep child\n`
    const result = mergeRules(original, [{ title: "New", description: "- recommended" }])
    expect(result).toContain(`${"#".repeat(depth)} ${RULES_HEADING}\n\n${"#".repeat(depth + 1)} New\n\n- recommended`)
    expect(result).toStartWith(original)
    expect(mergeRules(result, [{ title: "New", description: "updated recommendation" }])).toBe(result)
  })
}

test("deduplicates titles across different levels and never overwrites a user's existing description", () => {
  const original = "# Root\n\n#### Same\n\nUser choice\n"
  const result = mergeRules(original, [{ title: "Same", description: "Do not replace" }, { title: "New" }, { title: "New" }])
  expect(result).toContain("#### Same\n\nUser choice")
  expect(result).not.toContain("Do not replace")
  expect(result.match(/## New/g)).toHaveLength(1)
  expect(mergeRules(original, [{ title: "Same" }])).toBe(original)
})

test("reuses the existing container and inserts before the following sibling section", () => {
  const original = `## Root\n\n## ${RULES_HEADING}\n\n### Old\n\nOld body\n\n## Following\n\nDo not move\n`
  const result = mergeRules(original, [{ title: "New", description: "New body" }])
  expect(result.match(new RegExp(RULES_HEADING, "g"))).toHaveLength(1)
  expect(result).toContain("### New\n\nNew body\n\n## Following\n\nDo not move")
  expect(mergeRules(result, [{ title: "New" }])).toBe(result)
})

test("handles an empty document, CRLF and heading-looking paragraphs and fenced code", () => {
  expect(mergeRules("", [{ title: "Rule" }])).toBe(`# ${RULES_HEADING}\n\n## Rule\n`)
  const original = "Plain text\r\n\r\n```md\r\n# Fake\r\n```\r\n"
  const result = mergeRules(original, [{ title: "Fake", description: "real rule" }])
  expect(result).toContain(`# ${RULES_HEADING}\r\n\r\n## Fake`)
  expect(result).not.toMatch(/(?<!\r)\n/)
  expect(mergeRules(result, [{ title: "Fake" }])).toBe(result)
})

test("level-6 containers use nested list entries without creating invalid seven-hash headings", () => {
  const rules = [{ title: "Rule", description: "Body\n\n```md\n# code\n```" }, { title: "Second" }]
  const result = mergeRules("###### Only\n", rules)
  expect(result).toContain(`###### ${RULES_HEADING}\n\n- **Rule**\n\n  Body`)
  expect(result).not.toContain("####### ")
  expect(mergeRules(result, rules)).toBe(result)
  expect(mergeRules(result, [...rules, { title: "Third" }])).toContain("- **Third**")
})

test("reference definitions and HTML blocks do not corrupt section boundaries", () => {
  const text = `[reference]: https://example.test\n\n<!-- # ignored -->\n\n# First\n\nText [link][reference]\n\n# Second\n\nDescription\n`
  expect(parseRules(text)).toEqual([{ title: "First", description: "Text [link][reference]" }, { title: "Second", description: "Description" }])
})

test("unclosed code and HTML blocks never swallow recommendations or grow repeatedly", () => {
  for (const block of ["```md\nunfinished", "~~~\nunfinished", "<pre>\nunfinished", "<!-- unfinished"]) {
    expect(() => mergeRules(`# User\n\n${block}`, [{ title: "New" }])).toThrow("unclosed Markdown")
  }
})

test("literal Markdown punctuation in recommended titles remains literal and idempotent", () => {
  const rules = [{ title: "A *literal* [title] #" }]
  for (const original of ["# User\n", "###### User\n"]) {
    const result = mergeRules(original, rules)
    expect(mergeRules(result, rules)).toBe(result)
  }
})
