export const DEFAULT_KEYBIND = "ctrl+shift+f"

export function resolveSearchKeybind(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : DEFAULT_KEYBIND
}

export function sessionSearchEnabled(options: Readonly<Record<string, unknown>>) {
  const features = options.features
  return !(typeof features === "object" && features !== null && "sessionSearch" in features && features.sessionSearch === false)
}
