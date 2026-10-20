import { expect, test } from "bun:test"
import { createTmux } from "./tmux.js"

test("tmux tests use private sockets and never load the user's config", () => {
  const commands: string[][] = []
  const run = (args: string[]) => { commands.push(args); return { exitCode: 0, stdout: Buffer.from("pane"), stderr: Buffer.alloc(0) } }
  const first = createTmux(run)
  const second = createTmux(run)
  expect(first(["capture-pane"]).stdout.toString()).toBe("pane")
  second(["set-option", "-g", "remain-on-exit", "on"])
  first(["kill-server"])
  expect(commands.every((args) => args[1] === "-L" && args[3] === "-f" && args[4] === "/dev/null")).toBe(true)
  expect(commands[0][2]).not.toBe(commands[1][2])
  expect(commands[0][2]).toBe(commands[2][2])
})

test("tmux failures propagate except for explicitly best-effort cleanup", () => {
  const tmux = createTmux(() => ({ exitCode: 1, stdout: Buffer.alloc(0), stderr: Buffer.from("unavailable") }))
  expect(() => tmux(["new-session"])).toThrow("unavailable")
  expect(tmux(["kill-server"], false).exitCode).toBe(1)
})
