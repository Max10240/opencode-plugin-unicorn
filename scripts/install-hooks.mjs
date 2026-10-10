import { access, realpath } from "node:fs/promises"
import { execFileSync } from "node:child_process"
import path from "node:path"
import { fileURLToPath } from "node:url"

const cwd = fileURLToPath(new URL("../", import.meta.url))
const git = (...args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim()
let inRepository = false
try { inRepository = path.resolve(git("rev-parse", "--show-toplevel")) === await realpath(cwd) } catch {}
let existing
try { existing = git("config", "--get", "core.hooksPath") } catch { existing = "" }
if (inRepository && existing && existing !== ".githooks") {
  console.warn("Existing Git hooksPath preserved; run bun run sync:rules before committing or add it to your hook")
} else if (inRepository && !existing) {
  const hook = git("rev-parse", "--git-path", "hooks/pre-commit")
  const present = await access(path.resolve(cwd, hook)).then(() => true, () => false)
  if (present) console.warn("Existing pre-commit hook preserved; run bun run sync:rules before committing or add it to your hook")
  else git("config", "--local", "core.hooksPath", ".githooks")
}
