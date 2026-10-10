export async function disposeAll(cleanups: readonly (() => Promise<void>)[]) {
  const errors: unknown[] = []
  for (const cleanup of [...cleanups].reverse()) {
    try { await cleanup() } catch (error) { errors.push(error) }
  }
  if (errors.length) throw new AggregateError(errors, "Failed to clean up Unicorn plugins")
}

export function disposeAllSync(cleanups: readonly (() => void)[]) {
  const errors: unknown[] = []
  for (const cleanup of [...cleanups].reverse()) {
    try { cleanup() } catch (error) { errors.push(error) }
  }
  if (errors.length) throw new AggregateError(errors, "Failed to clean up Unicorn TUI plugins")
}
