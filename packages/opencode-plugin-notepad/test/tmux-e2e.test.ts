import { expect, setDefaultTimeout, test } from "bun:test"
import path from "node:path"
import { writeFile } from "node:fs/promises"
import { createOpenCodeE2E } from "../../opencode-plugin-unicorn/test/e2e-utils.js"
import { createSession } from "../../opencode-plugin-show-img/test/e2e-utils.js"
import { commandIsListed } from "../../opencode-plugin-prompt-search/test/palette.js"
import { createTmux } from "../../../test/tmux.js"

setDefaultTimeout(180_000)
const PASSWORD = "opencode-plugin-unicorn-e2e"
const MARKER = "NOTEPAD_E2E_MARKER_20261029"

test("notepad CRUD, global scope, palette and slash work in the real TUI", async () => {
  if (Bun.spawnSync(["tmux", "-V"]).exitCode !== 0) throw new Error("tmux is required for this E2E test")
  const e2e = await createOpenCodeE2E({
    plugin: "unicorn",
    pluginPackage: path.resolve(import.meta.dir, "../../opencode-plugin-unicorn"),
    pluginOptions: {
      features: {
        recommendedOpencodeConfig: false,
        sendMessageAcrossSessions: false,
        imageGen: false,
        showImg: false,
        promptSearch: false,
        sessionSearch: false,
        notepad: true,
      },
    },
  })
  const target = "tui"
  try {
    await e2e.waitForModelContext(200_000)
    await writeFile(
      path.join(e2e.configDirectory, "cli.json"),
      `${JSON.stringify({
        plugins: [{
          package: path.resolve(import.meta.dir, "../../opencode-plugin-unicorn"),
          options: {
            features: {
              promptSearch: false,
              sessionSearch: false,
              showImg: false,
              notepad: true,
            },
          },
        }],
      }, null, 2)}\n`,
    )
    const sessionID = await createSession(e2e, "Notepad-E2E")
    tmux(["new-session", "-d", "-s", target, "-x", "160", "-y", "48", command(e2e, sessionID)])
    await waitForPane(target, "Notepad-E2E", "TUI did not start")

    tmux(["send-keys", "-t", target, "C-p"])
    await waitForPane(target, "Commands", "command palette did not open")
    tmux(["send-keys", "-t", target, "-l", "Open notepad"])
    await waitFor(async () => commandIsListed(pane(target), "Open notepad"), "notepad is missing from the command palette")
    tmux(["send-keys", "-t", target, "Enter"])
    await waitForPane(target, "No notes yet", "empty notepad did not open")

    tmux(["send-keys", "-t", target, "a"])
    await waitForPane(target, "New note", "note editor did not open")
    await Bun.sleep(200)
    tmux(["send-keys", "-t", target, "-l", MARKER])
    await waitForPane(target, MARKER, "note text did not appear in the editor")
    tmux(["send-keys", "-t", target, "F2"])
    await waitForPane(target, MARKER, "note was not saved")
    await waitForPane(target, "folder ·", "new note was not scoped to the current folder")

    tmux(["send-keys", "-t", target, "g"])
    await waitForPane(target, "Moved to Global", "note scope did not change")
    await waitForPane(target, "global ·", "note was not shown as global")

    tmux(["send-keys", "-t", target, "c"])
    await waitForPane(target, "Copied note", "copy action did not report success")

    tmux(["send-keys", "-t", target, "Escape"])
    await waitFor(async () => !pane(target).includes("esc close"), "notepad dialog did not close")

    tmux(["send-keys", "-t", target, "-l", "/notepad"])
    await waitForPane(target, "Capture and manage notes", "notepad slash command is missing")
    tmux(["send-keys", "-t", target, "Enter"])
    await waitForPane(target, MARKER, "note did not persist after reopening")
    expect(pane(target)).toContain("global ·")

    tmux(["send-keys", "-t", target, "e"])
    await waitForPane(target, "Edit note", "note editor did not reopen")
    await Bun.sleep(200)
    tmux(["send-keys", "-t", target, "-l", " EDITED"])
    await waitForPane(target, " EDITED", "edited text did not appear in the editor")
    tmux(["send-keys", "-t", target, "F2"])
    await waitForPane(target, "EDITED", "note edit was not saved")
    await Bun.sleep(1000)

    tmux(["send-keys", "-t", target, "e"])
    await waitForPane(target, "Edit note", "note editor did not reopen for cancel")
    tmux(["send-keys", "-t", target, "Escape"])
    await waitForPane(target, MARKER, "cancel did not return to the note list")
    await Bun.sleep(500)

    tmux(["send-keys", "-t", target, "d"])
    await waitForPane(target, "Delete note?", "delete confirmation did not open")
    tmux(["send-keys", "-t", target, "Enter"])
    await waitForPane(target, "No notes yet", "note was not deleted")
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.message : String(error)}\n${pane(target)}`)
  } finally {
    tmux(["kill-server"], false)
    await e2e.close()
  }
})

function command(e2e: Awaited<ReturnType<typeof createOpenCodeE2E>>, sessionID: string) {
  const environment = {
    PATH: process.env.PATH ?? "/usr/bin:/bin:/opt/homebrew/bin",
    TERM: "xterm-256color",
    HOME: e2e.root,
    OPENCODE_CONFIG_DIR: e2e.configDirectory,
    OPENCODE_CONFIG_PROJECT_DISABLE: "1",
    OPENCODE_DB: path.join(e2e.root, "opencode.db"),
    OPENCODE_DISABLE_MODELS_FETCH: "1",
    OPENCODE_PASSWORD: PASSWORD,
    XDG_CONFIG_HOME: path.join(e2e.root, "xdg-config"),
    XDG_DATA_HOME: path.join(e2e.root, "xdg-data"),
    XDG_CACHE_HOME: path.join(e2e.root, "xdg-cache"),
    XDG_STATE_HOME: path.join(e2e.root, "xdg-state"),
  }
  const binary = process.env.OPENCODE_BIN ?? "opencode"
  return [
    `cd ${quote(e2e.workspace)} && env -i`,
    ...Object.entries(environment).map(([key, value]) => `${key}=${quote(value)}`),
    [binary, "--server", e2e.baseURL, "--session", sessionID].map(quote).join(" "),
  ].join(" ")
}

async function waitForPane(target: string, text: string, message: string) {
  try {
    await waitFor(async () => pane(target).includes(text), message)
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.message : String(error)}\n${pane(target)}`)
  }
}

async function waitFor(check: () => Promise<boolean>, message: string, timeout = 30_000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (await check()) return
    await Bun.sleep(100)
  }
  throw new Error(message)
}

function pane(target: string) {
  return tmux(["capture-pane", "-p", "-t", target], false).stdout.toString()
}

const tmux = createTmux()

function quote(value: string) {
  return `'${value.replaceAll("'", "'\\''")}'`
}
