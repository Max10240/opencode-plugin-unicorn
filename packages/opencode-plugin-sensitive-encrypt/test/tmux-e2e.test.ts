import { expect, setDefaultTimeout, test } from "bun:test"
import { generateKeyPairSync } from "node:crypto"
import { mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createOpenCodeE2E } from "../../opencode-plugin-unicorn/test/e2e-utils.js"
import { createSession } from "../../opencode-plugin-show-img/test/e2e-utils.js"
import { commandIsListed } from "../../opencode-plugin-prompt-search/test/palette.js"
import { createTmux } from "../../../test/tmux.js"
import { decryptEnvelope } from "../src/crypto.js"

setDefaultTimeout(240_000)

const PASSWORD = "opencode-plugin-unicorn-e2e"
const PALETTE_TITLE = "Encrypt sensitive file"
const SLASH = "/encrypt-sensitive"

test("manual encryption is reachable and works through the real TUI", async () => {
  if (Bun.spawnSync(["tmux", "-V"]).exitCode !== 0) throw new Error("tmux is required for this E2E test")
  await runScenario("standalone")
  await runScenario("unicorn")
})

async function runScenario(mode: "standalone" | "unicorn") {
  tmux = createTmux()
  const root = await mkdtemp(path.join(os.tmpdir(), `sensitive-encrypt-tui-${mode}-`))
  const secret = path.join(root, "secret.txt")
  const out = path.join(root, "secret.ocsec")
  const marker = `SENSITIVE_TUI_${mode.toUpperCase()}_MARKER`
  const { publicKey, privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  })
  const publicKeyFile = path.join(root, "public.pem")
  await writeFile(secret, marker, { mode: 0o600 })
  await writeFile(publicKeyFile, publicKey, { mode: 0o644 })

  const tuiPackage = path.resolve(import.meta.dir, mode === "unicorn" ? "../../opencode-plugin-unicorn" : "..")
  const pluginOptions = mode === "unicorn"
    ? {
        features: {
          recommendedOpencodeConfig: false,
          sendMessageAcrossSessions: false,
          imageGen: false,
          showImg: false,
          promptSearch: false,
          sessionSearch: false,
          sensitiveProtection: true,
        },
        sensitiveEncrypt: { publicKeyFileForEncrypt: publicKeyFile, decrypt: false },
      }
    : { publicKeyFileForEncrypt: publicKeyFile, decrypt: false }

  const e2e = await createOpenCodeE2E({
    plugin: mode === "unicorn" ? "unicorn" : "sensitive-encrypt",
    pluginPackage: mode === "unicorn" ? tuiPackage : path.resolve(import.meta.dir, "../dist"),
    pluginOptions,
  })
  // TUI plugin options come from cli.json; server inventory entries carry no options.
  await writeFile(
    path.join(e2e.configDirectory, "cli.json"),
    `${JSON.stringify({ plugins: [{ package: tuiPackage, options: pluginOptions }] }, null, 2)}\n`,
  )
  const target = "tui"
  try {
    await e2e.waitForModelContext(200_000)
    const sessionID = await createSession(e2e, `Sensitive-Encrypt-${mode}`)
    tmux(["new-session", "-d", "-s", target, "-x", "160", "-y", "48", tuiCommand(e2e, sessionID)])
    await waitForPane(target, "Sensitive-Encrypt-", "TUI did not start")

    // The command must be reachable while the palette holds the modal input mode.
    await openPalette(target)
    tmux(["send-keys", "-t", target, "-l", PALETTE_TITLE])
    await waitFor(async () => commandIsListed(screen(target), PALETTE_TITLE), "encryption command is missing from the command palette")
    tmux(["send-keys", "-t", target, "Escape"])
    await waitFor(async () => !screen(target).includes("Commands"), "command palette did not close")

    // The slash completion inserts an autocomplete mode, which must stay reachable too.
    tmux(["send-keys", "-t", target, "-l", SLASH])
    await waitForPane(target, "Encrypt a file under $TMPDIR", "slash command is missing from autocomplete")
    tmux(["send-keys", "-t", target, "Escape"])
    await clearPrompt(target, SLASH.length)

    if (mode === "unicorn") {
      // The protection command uses the same layer shape and must stay reachable too.
      await openPalette(target)
      tmux(["send-keys", "-t", target, "-l", "Protect sensitive file"])
      await waitFor(async () => commandIsListed(screen(target), "Protect sensitive file"), "protection command is missing from the command palette")
      tmux(["send-keys", "-t", target, "Escape"])
      await waitFor(async () => !screen(target).includes("Commands"), "command palette did not close after protection lookup")
      tmux(["send-keys", "-t", target, "-l", "/protect-sensitive-file-ui"])
      await waitForPane(target, "Register an existing file as protected", "protection slash command is missing from autocomplete")
      tmux(["send-keys", "-t", target, "Escape"])
      await clearPrompt(target, "/protect-sensitive-file-ui".length)
    }

    // Invoke through the palette in standalone mode and through slash in Unicorn.
    if (mode === "unicorn") {
      tmux(["send-keys", "-t", target, "-l", SLASH])
      await waitForPane(target, "Encrypt a file under $TMPDIR", "slash command disappeared before invocation")
      tmux(["send-keys", "-t", target, "Enter"])
    } else {
      await openPalette(target)
      tmux(["send-keys", "-t", target, "-l", PALETTE_TITLE])
      await waitFor(async () => commandIsListed(screen(target), PALETTE_TITLE), "encryption command disappeared from the palette")
      tmux(["send-keys", "-t", target, "Enter"])
    }
    await waitForPane(target, "Input file under $TMPDIR", "encryption file dialog did not open")
    tmux(["send-keys", "-t", target, "-l", secret])
    tmux(["send-keys", "-t", target, "Enter"])
    await waitForPane(target, "Ciphertext output (optional)", "encryption output dialog did not open")
    tmux(["send-keys", "-t", target, "-l", out])
    tmux(["send-keys", "-t", target, "Enter"])
    await waitForPane(target, "Encrypted with key", "encryption result dialog did not open")
    await waitFor(
      async () => {
        const resolved = await realpath(out).catch(() => out)
        return screen(target).replace(/\s+/g, "").includes(`Output:${resolved}`)
      },
      "encryption result did not show the output path",
    )
    expect(screen(target)).not.toContain(marker)

    // The result dialog is intentionally persistent and exposes copy actions.
    await Bun.sleep(1_500)
    expect(screen(target)).toContain("Encrypted with key")
    tmux(["send-keys", "-t", target, "p"])
    await waitForPane(target, "Copied output path", "copying the output path did not report success")
    tmux(["send-keys", "-t", target, "c"])
    await waitForPane(target, "Copied ciphertext", "copying the ciphertext did not report success")

    tmux(["send-keys", "-t", target, "Escape"])
    await waitFor(async () => !screen(target).includes("Encrypted with key"), "result dialog did not close")
    tmux(["send-keys", "-t", target, "-l", "TUI_STILL_ALIVE"])
    await waitForPane(target, "TUI_STILL_ALIVE", "TUI was not usable after closing the result dialog")
    await clearPrompt(target, "TUI_STILL_ALIVE".length)

    const ciphertext = await readFile(out, "utf8")
    expect(ciphertext).toStartWith("ocsec1:")
    expect(ciphertext).not.toContain(marker)
    expect(decryptEnvelope(ciphertext, privateKey).toString("utf8")).toBe(marker)
    if (process.platform !== "win32") expect((await stat(out)).mode & 0o777).toBe(0o600)
    expect(JSON.stringify(e2e.proxy.requests)).not.toContain(marker)
  } catch (error) {
    const log = await readFile(path.join(e2e.root, "xdg-data/opencode/log/opencode.log"), "utf8").catch(() => "")
    throw new Error(`${error instanceof Error ? error.message : String(error)}\n--- ${mode} TUI ---\n${capture(target)}\n--- plugin log ---\n${log.split("\n").filter((line) => /plugin|tui|error/i.test(line)).slice(-20).join("\n")}`)
  } finally {
    tmux(["kill-server"], false)
    await e2e.close()
    await rm(root, { recursive: true, force: true })
  }
}

async function openPalette(target: string) {
  tmux(["send-keys", "-t", target, "C-p"])
  await waitForPane(target, "Commands", "command palette did not open")
}

function tuiCommand(e2e: Awaited<ReturnType<typeof createOpenCodeE2E>>, sessionID: string) {
  const environment = {
    PATH: process.env.PATH ?? "/usr/bin:/bin:/opt/homebrew/bin",
    TERM: "xterm-256color",
    ...(process.env.TMPDIR === undefined ? {} : { TMPDIR: process.env.TMPDIR }),
    HOME: e2e.root,
    OPENCODE_CONFIG_DIR: e2e.configDirectory,
    OPENCODE_CONFIG_PROJECT_DISABLE: "1",
    OPENCODE_DB: path.join(e2e.root, "opencode.db"),
    OPENCODE_DISABLE_MODELS_FETCH: "1",
    OPENCODE_PASSWORD: PASSWORD,
    OPENCODE_TEST_HOME: e2e.root,
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

async function clearPrompt(target: string, length: number) {
  if (length <= 0) return
  tmux(["send-keys", "-t", target, "-N", String(length), "BSpace"])
  await Bun.sleep(100)
}

async function waitForPane(target: string, text: string, message: string) {
  try {
    await waitFor(async () => screen(target).includes(text), message)
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.message : String(error)}\n${capture(target)}`)
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

function screen(target: string) {
  return capture(target)
}

function capture(target: string) {
  return tmux(["capture-pane", "-p", "-t", target], false).stdout.toString()
}

type Tmux = ReturnType<typeof createTmux>
let tmux: Tmux = createTmux()

function quote(value: string) {
  return `'${value.replaceAll("'", "'\\''")}'`
}
