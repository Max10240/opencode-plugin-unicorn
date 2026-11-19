export type QueryToken = {
  readonly value: string
  readonly excluded: boolean
  readonly phrase: boolean
}

export type ParsedQuery = {
  readonly tokens: readonly QueryToken[]
  readonly terms: readonly string[]
  readonly excludes: readonly string[]
}

export type MatchRange = { readonly start: number; readonly end: number }

export function parseQuery(input: string): ParsedQuery {
  const tokens: QueryToken[] = []
  let index = 0
  while (index < input.length) {
    while (index < input.length && /\s/.test(input[index]!)) index++
    if (index >= input.length) break
    let excluded = false
    if (input[index] === "-" && input[index + 1] !== undefined && !/\s/.test(input[index + 1]!)) {
      excluded = true
      index++
    }
    let phrase = false
    let value = ""
    if (input[index] === '"') {
      phrase = true
      index++
      while (index < input.length && input[index] !== '"') {
        value += input[index]
        index++
      }
      if (input[index] === '"') index++
    } else {
      while (index < input.length && !/\s/.test(input[index]!)) {
        value += input[index]
        index++
      }
    }
    const normalized = value.trim().toLowerCase()
    if (normalized) tokens.push({ value: normalized, excluded, phrase })
  }
  return {
    tokens,
    terms: tokens.filter((token) => !token.excluded).map((token) => token.value),
    excludes: tokens.filter((token) => token.excluded).map((token) => token.value),
  }
}

/** Returns every positive match range, or undefined when the entry does not satisfy the query. */
export function matchText(value: string, query: ParsedQuery): MatchRange[] | undefined {
  if (query.tokens.length === 0) return []
  const folded = value.toLowerCase()
  for (const token of query.tokens) {
    if (folded.includes(token.value) === token.excluded) return undefined
  }
  const ranges: MatchRange[] = []
  for (const term of query.terms) {
    let from = 0
    while (ranges.length < 64) {
      const at = folded.indexOf(term, from)
      if (at < 0) break
      ranges.push({ start: at, end: at + term.length })
      from = at + Math.max(1, term.length)
    }
  }
  return mergeRanges(ranges)
}

export function matchesText(value: string, query: ParsedQuery) {
  return matchText(value, query) !== undefined
}

export function mergeRanges(ranges: readonly MatchRange[]): MatchRange[] {
  const sorted = [...ranges].sort((left, right) => left.start - right.start || left.end - right.end)
  const merged: MatchRange[] = []
  for (const range of sorted) {
    const last = merged[merged.length - 1]
    if (last && range.start <= last.end) {
      merged[merged.length - 1] = { start: last.start, end: Math.max(last.end, range.end) }
      continue
    }
    merged.push(range)
  }
  return merged
}
