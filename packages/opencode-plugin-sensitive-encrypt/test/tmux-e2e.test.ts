import { expect, setDefaultTimeout, test } from "bun:test"
import { generateKeyPairSync } from "node:crypto"
import { mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createOpenCodeE2E } from "../../opencode-plugin-unicorn/test/e2e-utils.js"
import { createSession } from "../../opencode-plugin-show-img/test/e2e-utils.js"
import { commandIsListed } from "../../opencode-plugin-prompt-search/test/palette.js"
import { createTmux } from "../../../test/tmux.js"
import { decryptEnvelope, parsePublicKey } from "../src/crypto.js"

setDefaultTimeout(240_000)

const PASSWORD = "opencode-plugin-unicorn-e2e"
const PALETTE_TITLE = "Encrypt sensitive data"
const SLASH = "/encrypt-sensitive"

test("manual encryption is reachable and works through the real TUI", async () => {
  if (Bun.spawnSync(["tmux", "-V"]).exitCode !== 0) throw new Error("tmux is required for this E2E test")
  await Promise.all([runScenario("standalone"), runScenario("unicorn")])
})

async function runScenario(mode: "standalone" | "unicorn") {
  const tmux = createTmux()
  const root = await mkdtemp(path.join(os.tmpdir(), `sensitive-encrypt-tui-${mode}-`))
  const secret = path.join(root, `secret-${mode}.txt`)
  const out = path.join(root, "text.ocsec")
  const fileOut = path.join(root, "secret.ocsec")
  const marker = `SENSITIVE_TUI_${mode.toUpperCase()}_MARKER`
  const encryptPair = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  })
  const decryptPair = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  })
  const publicKeyFile = path.join(root, "public.pem")
  const decryptPrivateFile = path.join(root, "decrypt-private.pem")
  await writeFile(secret, marker, { mode: 0o600 })
  await writeFile(publicKeyFile, encryptPair.publicKey, { mode: 0o644 })
  await writeFile(decryptPrivateFile, decryptPair.privateKey, { mode: 0o600 })

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
        sensitiveEncrypt: { publicKeyFileForEncrypt: publicKeyFile, privateKeyFileForDecrypt: decryptPrivateFile, decrypt: true },
      }
    : { publicKeyFileForEncrypt: publicKeyFile, privateKeyFileForDecrypt: decryptPrivateFile, decrypt: true }

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
    await waitForPane(tmux, target, "Sensitive-Encrypt-", "TUI did not start")
    await Bun.sleep(150)

    // The command must be reachable while the palette holds the modal input mode.
    await openPalette(tmux, target)
    tmux(["send-keys", "-t", target, "-l", PALETTE_TITLE])
    await waitFor(async () => commandIsListed(screen(tmux, target), PALETTE_TITLE), "encryption command is missing from the command palette")
    tmux(["send-keys", "-t", target, "Escape"])
    await waitFor(async () => !screen(tmux, target).includes("Commands"), "command palette did not close")

    // The slash completion inserts an autocomplete mode, which must stay reachable too.
    tmux(["send-keys", "-t", target, "-l", SLASH])
    await waitForPane(tmux, target, "Encrypt in-memory text or a file with the configured public key", "slash command is missing from autocomplete")
    tmux(["send-keys", "-t", target, "Escape"])
    await clearPrompt(tmux, target, SLASH.length)

    if (mode === "unicorn") {
      // The protection command uses the same layer shape and must stay reachable too.
      await openPalette(tmux, target)
      tmux(["send-keys", "-t", target, "-l", "Protect sensitive file"])
      await waitFor(async () => commandIsListed(screen(tmux, target), "Protect sensitive file"), "protection command is missing from the command palette")
      tmux(["send-keys", "-t", target, "Escape"])
      await waitFor(async () => !screen(tmux, target).includes("Commands"), "command palette did not close after protection lookup")
      tmux(["send-keys", "-t", target, "-l", "/protect-sensitive-file-ui"])
      await waitForPane(tmux, target, "Register an existing file as protected", "protection slash command is missing from autocomplete")
      tmux(["send-keys", "-t", target, "Escape"])
      await clearPrompt(tmux, target, "/protect-sensitive-file-ui".length)
    }

    // Open with the palette in standalone and with slash in Unicorn.
    if (mode === "unicorn") {
      tmux(["send-keys", "-t", target, "-l", SLASH])
      await waitForPane(tmux, target, "Encrypt in-memory text or a file with the configured public key", "slash command disappeared before invocation")
      tmux(["send-keys", "-t", target, "Enter"])
    } else {
      await openPalette(tmux, target)
      tmux(["send-keys", "-t", target, "-l", PALETTE_TITLE])
      await waitFor(async () => commandIsListed(screen(tmux, target), PALETTE_TITLE), "encryption command disappeared from the palette")
      tmux(["send-keys", "-t", target, "Enter"])
    }
    await waitForPane(tmux, target, "Encrypt sensitive data", "encryption panel did not open")
    await waitForPane(tmux, target, "Type any text to encrypt", "text mode is not the default")
    await Bun.sleep(300)

    // Text mode: encrypt from memory, with an optional ciphertext file.
    tmux(["send-keys", "-t", target, "-l", marker])
    await waitForPane(tmux, target, marker, "text input did not appear")
    tmux(["send-keys", "-t", target, "C-t"])
    await waitForPane(tmux, target, "[File]", "file mode did not activate for the persistence check")
    tmux(["send-keys", "-t", target, "C-t"])
    await waitForPane(tmux, target, "[Text]", "text mode did not reactivate")
    await waitForPane(tmux, target, marker, "text was lost when switching modes")
    tmux(["send-keys", "-t", target, "Tab"])
    tmux(["send-keys", "-t", target, "-l", out])
    await waitForPane(tmux, target, path.basename(out), "text output path did not appear")
    await pressUntil(tmux, target, "F2", "Encrypted with key", "text encryption result dialog did not open")
    expect(screen(tmux, target).replace(/\s+/g, "")).toContain(parsePublicKey(decryptPair.publicKey).kid)
    await waitFor(
      async () => {
        const resolved = await realpath(out).catch(() => out)
        return screen(tmux, target).replace(/\s+/g, "").includes(`Output:${resolved}`)
      },
      "text encryption result did not show the output path",
    )
    expect(screen(tmux, target)).not.toContain(marker)

    await Bun.sleep(1_000)
    expect(screen(tmux, target)).toContain("Encrypted with key")
    tmux(["send-keys", "-t", target, "p"])
    await waitForPane(tmux, target, "Copied output path", "copying the text ciphertext path did not report success")
    tmux(["send-keys", "-t", target, "c"])
    await waitForPane(tmux, target, "Copied ciphertext", "copying the text ciphertext did not report success")

    const textCiphertext = await readFile(out, "utf8")
    expect(textCiphertext).toStartWith("ocsec1:")
    expect(textCiphertext).not.toContain(marker)
    expect(decryptEnvelope(textCiphertext, decryptPair.privateKey).toString("utf8")).toBe(marker)
    if (process.platform !== "win32") expect((await stat(out)).mode & 0o777).toBe(0o600)

    const copiedBefore = (screen(tmux, target).match(/Copied (?:output path|ciphertext)/g) ?? []).length
    tmux(["send-keys", "-t", target, "Escape"])
    await waitFor(async () => !screen(tmux, target).includes("Encrypted with key"), "text result dialog did not close")

    // Result-dialog shortcuts must not leak after the dialog closes.
    tmux(["send-keys", "-t", target, "-l", "cp"])
    await Bun.sleep(300)
    expect((screen(tmux, target).match(/Copied (?:output path|ciphertext)/g) ?? []).length).toBeLessThanOrEqual(copiedBefore)
    for (let index = 0; index < 2; index++) tmux(["send-keys", "-t", target, "BSpace"])

    // Panel shortcuts must not leak into another modal dialog.
    await openPalette(tmux, target)
    tmux(["send-keys", "-t", target, "-l", "cp"])
    await Bun.sleep(300)
    expect((screen(tmux, target).match(/Copied (?:output path|ciphertext)/g) ?? []).length).toBeLessThanOrEqual(copiedBefore)
    expect(screen(tmux, target)).not.toContain("Type any text to encrypt")
    expect(screen(tmux, target)).not.toContain("f2 encrypt")
    tmux(["send-keys", "-t", target, "Escape"])
    await waitFor(async () => !screen(tmux, target).includes("Commands"), "command palette did not close after isolation check")

    // File mode: still manually typed, and still never uses the model tool.
    await openPalette(tmux, target)
    tmux(["send-keys", "-t", target, "-l", PALETTE_TITLE])
    await waitFor(async () => commandIsListed(screen(tmux, target), PALETTE_TITLE), "encryption command disappeared for file mode")
    tmux(["send-keys", "-t", target, "Enter"])
    await waitForPane(tmux, target, "Encrypt sensitive data", "encryption panel did not reopen")
    await Bun.sleep(200)
    tmux(["send-keys", "-t", target, "C-t"])
    await waitForPane(tmux, target, "[File]", "file mode did not activate")
    await Bun.sleep(300)
    await waitForPane(tmux, target, "Key: Decrypt", "default encryption key was not derived from the decrypt private key")
    tmux(["send-keys", "-t", target, "Tab"])
    tmux(["send-keys", "-t", target, "Tab"])
    await waitForPane(tmux, target, "left/right change", "encryption key selector is not focusable")
    tmux(["send-keys", "-t", target, "Right"])
    await waitForPane(tmux, target, "Key: Encrypt", "encryption key did not switch to the encrypt public key")
    // Re-enter file mode so focus returns to the primary input even after a plugin reload.
    tmux(["send-keys", "-t", target, "C-t"])
    await waitForPane(tmux, target, "[Text]", "text mode did not activate while restoring focus")
    tmux(["send-keys", "-t", target, "C-t"])
    await waitForPane(tmux, target, "[File]", "file mode did not reactivate while restoring focus")
    tmux(["send-keys", "-t", target, "-l", secret])
    await waitForPane(tmux, target, path.basename(secret), "file path did not appear", 60_000)
    tmux(["send-keys", "-t", target, "Tab"])
    tmux(["send-keys", "-t", target, "-l", fileOut])
    await waitForPane(tmux, target, path.basename(fileOut), "file output path did not appear")
    await pressUntil(tmux, target, "F2", "Encrypted with key", "file encryption result dialog did not open")
    expect(screen(tmux, target).replace(/\s+/g, "")).toContain(parsePublicKey(encryptPair.publicKey).kid)
    await waitFor(
      async () => {
        const resolved = await realpath(fileOut).catch(() => fileOut)
        return screen(tmux, target).replace(/\s+/g, "").includes(`Output:${resolved}`)
      },
      "file encryption result did not show the output path",
    )

    const fileCiphertext = await readFile(fileOut, "utf8")
    expect(fileCiphertext).toStartWith("ocsec1:")
    expect(fileCiphertext).not.toContain(marker)
    expect(decryptEnvelope(fileCiphertext, encryptPair.privateKey).toString("utf8")).toBe(marker)
    if (process.platform !== "win32") expect((await stat(fileOut)).mode & 0o777).toBe(0o600)
    expect(JSON.stringify(e2e.proxy.requests)).not.toContain(marker)
  } catch (error) {
    const log = await readFile(path.join(e2e.root, "xdg-data/opencode/log/opencode.log"), "utf8").catch(() => "")
    throw new Error(`${error instanceof Error ? error.message : String(error)}\n--- ${mode} TUI ---\n${capture(tmux, target)}\n--- plugin log ---\n${log.split("\n").filter((line) => /plugin|tui|error/i.test(line)).slice(-20).join("\n")}`)
  } finally {
    tmux(["kill-server"], false)
    await e2e.close()
    await rm(root, { recursive: true, force: true })
  }
}

async function pressUntil(tmux: Tmux, target: string, key: string, text: string, message: string) {
  for (let attempt = 0; attempt < 3; attempt++) {
    tmux(["send-keys", "-t", target, key])
    try {
      await waitForPane(tmux, target, text, message, 10_000)
      return
    } catch (error) {
      if (!screen(tmux, target).includes("Encrypt sensitive data")) throw error
    }
  }
  await waitForPane(tmux, target, text, message)
}

async function openPalette(tmux: Tmux, target: string) {
  for (let attempt = 0; attempt < 5; attempt++) {
    if (screen(tmux, target).includes("Commands")) return
    tmux(["send-keys", "-t", target, "C-p"])
    try {
      await waitForPane(tmux, target, "Commands", "command palette did not open", 5_000)
      return
    } catch {}
    await Bun.sleep(100)
  }
  throw new Error("command palette did not open")
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

async function clearPrompt(tmux: Tmux, target: string, length: number) {
  if (length <= 0) return
  tmux(["send-keys", "-t", target, "-N", String(length), "BSpace"])
  await Bun.sleep(25)
}

async function waitForPane(tmux: Tmux, target: string, text: string, message: string, timeout = 30_000) {
  try {
    await waitFor(async () => screen(tmux, target).includes(text), message, timeout)
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.message : String(error)}\n${capture(tmux, target)}`)
  }
}

async function waitFor(check: () => Promise<boolean>, message: string, timeout = 30_000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (await check()) return
    await Bun.sleep(25)
  }
  throw new Error(message)
}

function screen(tmux: Tmux, target: string) {
  return capture(tmux, target)
}

function capture(tmux: Tmux, target: string) {
  return tmux(["capture-pane", "-p", "-t", target], false).stdout.toString()
}

type Tmux = ReturnType<typeof createTmux>

function quote(value: string) {
  return `'${value.replaceAll("'", "'\\''")}'`
}
