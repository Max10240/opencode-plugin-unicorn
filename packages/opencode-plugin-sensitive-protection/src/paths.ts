import { lstat, realpath } from "node:fs/promises"
import path from "node:path"
import os from "node:os"

export function expandProtectedPath(value: string, directory: string) {
  if (typeof value !== "string" || !value.trim()) throw new Error("file must be a non-empty path")
  const root = path.resolve(os.tmpdir())
  const home = process.env.HOME ?? os.homedir()
  const expanded = value === "~"
    ? home
    : value.startsWith("~/")
      ? path.join(home, value.slice(2))
      : value === "$TMPDIR" || value === "${TMPDIR}"
        ? root
        : value.startsWith("$TMPDIR/")
          ? path.join(root, value.slice(8))
          : value.startsWith("${TMPDIR}/")
            ? path.join(root, value.slice(11))
            : value
  return path.isAbsolute(expanded) ? expanded : path.resolve(directory, expanded)
}

export async function resolveProtectedPath(value: string, directory: string) {
  return realpath(expandProtectedPath(value, directory))
}

export async function fileIsRegular(value: string) {
  const info = await lstat(value).catch(() => undefined)
  return info?.isFile() === true
}
