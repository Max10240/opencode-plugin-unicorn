export function commandIsListed(screen: string, title: string) {
  // One occurrence is the typed query; a second must be in the command results.
  return screen.split(title).length >= 3
}
