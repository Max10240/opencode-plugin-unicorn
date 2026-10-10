import { Lexer, type Token, type Tokens } from "marked"

export const RULES_HEADING = "Addtional Recommended Rules"
export type RecommendedRule = { title: string; description?: string }
type Heading = { title: string; depth: number; start: number; end: number }

function normalize(text: string) { return text.replace(/\r\n?/g, "\n") }
function titleKey(text: string) { return text.trim().replace(/\s+/g, " ") }
function markdownTitle(text: string) { return titleKey(text).replace(/([\\*_`[\]<>#~])/g, "\\$1") }
function inlineText(tokens: Token[]): string {
  return tokens.map((token) => {
    if ("tokens" in token && Array.isArray(token.tokens)) return inlineText(token.tokens)
    return "text" in token && typeof token.text === "string" ? token.text : ""
  }).join("")
}

function headings(text: string): Heading[] {
  let offset = 0
  const result: Heading[] = []
  for (const token of Lexer.lex(text)) {
    if (token.type === "heading") {
      const heading = token as Tokens.Heading
      result.push({ title: titleKey(inlineText(heading.tokens)), depth: heading.depth, start: offset, end: offset + heading.raw.length })
    }
    offset += token.raw.length
  }
  return result
}

export function parseRules(markdown: string): RecommendedRule[] {
  const text = normalize(markdown)
  const entries = headings(text)
  return entries.map((heading, index) => {
    const description = text.slice(heading.end, entries[index + 1]?.start ?? text.length).trim()
    return { title: heading.title, ...(description ? { description } : {}) }
  })
}

export function mergeRules(markdown: string, rules: readonly RecommendedRule[]): string {
  const text = normalize(markdown)
  const entries = headings(text)
  const existing = entries.find((heading) => heading.title === RULES_HEADING)
  const end = existing ? entries.find((heading) => heading.start > existing.start && heading.depth <= existing.depth)?.start ?? text.length : text.length
  const titles = ruleTitles(text, entries)
  const missing = rules.filter((rule) => {
    const title = titleKey(rule.title)
    if (!title || title === RULES_HEADING || titles.has(title)) return false
    titles.add(title)
    return true
  })
  if (!missing.length) return markdown
  const depth = existing?.depth ?? (entries.length ? Math.min(...entries.map((heading) => heading.depth)) : 1)
  const content = missing.map((rule) => {
    if (depth < 6) return `${"#".repeat(depth + 1)} ${markdownTitle(rule.title)}${rule.description ? `\n\n${rule.description.trim()}` : ""}`
    const title = markdownTitle(rule.title)
    const description = rule.description?.trim().split("\n").map((line) => line ? `  ${line}` : "").join("\n")
    return `- **${title}**${description ? `\n\n${description}` : ""}`
  }).join("\n\n")
  const before = text.slice(0, end).replace(/\n*$/, "")
  const after = text.slice(end)
  const added = existing ? content : `${"#".repeat(depth)} ${RULES_HEADING}\n\n${content}`
  const updated = `${before}${before ? "\n\n" : ""}${added}\n${after ? `\n${after}` : ""}`
  // An unclosed code/HTML block can swallow appended headings. Do not corrupt or repeatedly grow it.
  const resulting = headings(updated)
  if (!resulting.some((heading) => heading.title === RULES_HEADING)) throw new Error("Recommended rules are inside an unclosed Markdown block; update skipped")
  const mergedAgain = ruleTitles(updated, resulting)
  if (missing.some((rule) => !mergedAgain.has(titleKey(rule.title)))) throw new Error("Recommended rules cannot be safely represented as Markdown; update skipped")
  return markdown.includes("\r\n") ? updated.replace(/\n/g, "\r\n") : updated
}

function ruleTitles(text: string, entries: Heading[]) {
  const titles = new Set(entries.map((heading) => heading.title))
  const container = entries.find((heading) => heading.title === RULES_HEADING)
  if (container?.depth === 6) {
    const end = entries.find((heading) => heading.start > container.start && heading.depth <= container.depth)?.start ?? text.length
    for (const token of Lexer.lex(text.slice(container.end, end))) {
      if (token.type !== "list") continue
      for (const item of (token as Tokens.List).items) {
        const paragraph = item.tokens.find((token) => token.type === "text" || token.type === "paragraph")
        const first = paragraph && "tokens" in paragraph ? paragraph.tokens?.[0] : undefined
        if (first?.type === "strong" && "tokens" in first) titles.add(titleKey(inlineText(first.tokens as Token[])))
      }
    }
  }
  return titles
}
