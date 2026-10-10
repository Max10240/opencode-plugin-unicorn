export function recommendedConfigEnabled(options: Readonly<Record<string, unknown>>, environment: NodeJS.ProcessEnv = process.env) {
  if (typeof options.enabled === "boolean") return options.enabled
  const value = environment.IS_MAX_SELF?.trim().toLowerCase()
  return Boolean(value && value !== "0" && value !== "false")
}
