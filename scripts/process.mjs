import { spawn } from "node:child_process"

export function runCommand(args, { cwd, env = process.env, capture = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(args[0], args.slice(1), { cwd, env, stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit" })
    let stdout = ""
    let stderr = ""
    if (capture) {
      child.stdout.setEncoding("utf8").on("data", (data) => { stdout += data })
      child.stderr.setEncoding("utf8").on("data", (data) => { stderr += data })
    }
    child.once("error", reject)
    child.once("close", (code, signal) => code === 0 ? resolve(stdout) : reject(new Error(`${args.join(" ")} failed (${signal ?? code})\n${stderr}`)))
  })
}

export async function timed(label, run) {
  const start = performance.now()
  try { return await run() } finally { console.log(`[check] ${label}: ${((performance.now() - start) / 1000).toFixed(2)}s`) }
}
