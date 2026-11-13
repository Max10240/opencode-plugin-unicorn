export function formatPercent(value: number) {
  return `${Math.round(Math.max(0, Math.min(100, value)))}%`
}

export function formatReset(at: number) {
  const date = new Date(at)
  if (!Number.isFinite(date.getTime())) return "unknown"
  const time = date.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }).replace(/\u202f/g, " ")
  if (date.toDateString() === new Date().toDateString()) return `${time} today`
  const day = date.toLocaleDateString("en-US", { month: "short", day: "numeric" })
  return date.getHours() === 0 && date.getMinutes() === 0 ? day : `${day}, ${time}`
}

export function meterBar(value: number, width = 20) {
  const percent = Math.max(0, Math.min(100, value))
  const filled = Math.round((percent / 100) * width)
  return `${"█".repeat(filled)}${"░".repeat(width - filled)}`
}
