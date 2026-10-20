import { expect, test } from "bun:test"
import { runCommand } from "../scripts/process.mjs"

test("captured commands wait for all output to drain", async () => {
  const output = await runCommand(["node", "-e", "process.stdout.write('x'.repeat(200000))"], { capture: true })
  expect(output).toHaveLength(200_000)
})

test("command exit and spawn failures propagate", async () => {
  await expect(runCommand(["node", "-e", "process.stderr.write('fixture failure'); process.exitCode=7"], { capture: true })).rejects.toThrow("fixture failure")
  await expect(runCommand([`missing-test-command-${crypto.randomUUID()}`], { capture: true })).rejects.toThrow()
})
