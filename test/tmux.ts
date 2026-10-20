type Result = { exitCode: number; stdout: Buffer; stderr: Buffer }

export function createTmux(
  run: (args: string[]) => Result = (args) => Bun.spawnSync(args, { stdout: "pipe", stderr: "pipe" }),
  socket = `unicorn-test-${process.pid}-${crypto.randomUUID()}`,
) {
  return (args: string[], throwOnFailure = true) => {
    const result = run(["tmux", "-L", socket, "-f", "/dev/null", ...args])
    if (throwOnFailure && result.exitCode !== 0) throw new Error(`tmux ${args[0]} failed: ${result.stderr.toString()}`)
    return result
  }
}
