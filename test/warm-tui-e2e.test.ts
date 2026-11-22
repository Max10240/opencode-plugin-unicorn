import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createOpenCodeE2E } from "../packages/opencode-plugin-unicorn/test/e2e-utils.js"
import { api, createSession, prompt, showImage } from "../packages/opencode-plugin-show-img/test/e2e-utils.js"
import { commandIsListed } from "../packages/opencode-plugin-prompt-search/test/palette.js"
import { decryptEnvelope, parsePublicKey } from "../packages/opencode-plugin-sensitive-encrypt/src/crypto.js"
import { createTui, waitFor, type Tui } from "./tui-support.js"

setDefaultTimeout(180_000)

const MARKER = "WARM_TUI_NOTE_MARKER"
const SEARCH_MARKER = "WARM_TUI_SEARCH_MARKER"
const LONG_TITLE = "Session-Search-Warm"
const LONG_MARKER = "020"

let e2e: Awaited<ReturnType<typeof createOpenCodeE2E>>
let tui: Tui
let longTui: Tui
let sessionID: string
let longSessionID: string
let textOutput: string
let imageFile: string
let encryptPrivateKey: string
let encryptPublicKey: string
let fixtureRoot: string

beforeAll(async () => {
  if (Bun.spawnSync(["tmux", "-V"]).exitCode !== 0) throw new Error("tmux is required for this E2E test")
  fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "unicorn-warm-tui-"))
  textOutput = path.join(fixtureRoot, "warm-text.ocsec")
  imageFile = path.join(fixtureRoot, "warm-image.png")
  await writeFile(imageFile, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64"))

  const pluginPackage = path.resolve(import.meta.dir, "../packages/opencode-plugin-unicorn")
  const pluginOptions = {
    features: {
      recommendedOpencodeConfig: false,
      sendMessageAcrossSessions: false,
      imageGen: false,
      showImg: true,
      promptSearch: true,
      sessionSearch: true,
      notepad: true,
      sensitiveEncrypt: true,
      sensitiveProtection: true,
      nonBlocking: false,
    },
    promptSearch: { keybind: "f12", maxPrompts: 2_000 },
    sessionSearch: { keybind: "f11" },
    sensitiveEncrypt: { decrypt: true },
  }
  e2e = await createOpenCodeE2E({ plugin: "unicorn", pluginPackage, pluginOptions })
  await e2e.waitForModelContext(200_000)
  encryptPublicKey = await readFile(path.join(e2e.configDirectory, "sensitive-encrypt", "encrypt-public.pem"), "utf8")
  encryptPrivateKey = await readFile(path.join(e2e.configDirectory, "sensitive-encrypt", "encrypt-private.pem"), "utf8")
  const tuiOptions = {
    ...pluginOptions,
    sensitiveEncrypt: { decrypt: true },
  }
  await writeFile(path.join(e2e.configDirectory, "cli.json"), `${JSON.stringify({
    session: { scrollbar: true, image_preview: false },
    prompt: { image_preview: false },
    keybinds: {
      "command.palette.show": "f10",
      "session.list": "f8",
      "session.message.user.next": "f6",
      "session.message.user.previous": "f7",
      "session.last": "f9",
    },
    plugins: [{ package: pluginPackage, options: tuiOptions }],
  }, null, 2)}\n`)

  sessionID = await createSession(e2e, "Warm-TUI")
  const history = await createSession(e2e, "Prompt-History-Warm")
  for (let index = 1; index <= 8; index++) {
    await prompt(e2e, history, `history-candidate-${String(index).padStart(2, "0")} from another session`)
  }

  const seeded = await createSession(e2e, "Session-Search-Seed")
  await prompt(e2e, seeded, "SEED_SESSION_SEARCH")
  const original = (await api<any>(e2e, `/api/experimental/session/${seeded}/export`)).data
  const user = original.messages.find((message: any) => message.type === "user")
  const assistant = original.messages.find((message: any) => message.type === "assistant")
  const idle = original.messages.find((message: any) => message.type === "idle")
  const rootID = crypto.randomUUID().replaceAll("-", "")
  const messageID = (index: number) => `msg_00000000${String(index).padStart(6, "0")}${rootID}`
  const messages: any[] = []
  const start = Date.now() - 100_000
  for (let index = 0; index < 30; index++) {
    const mark = String(index).padStart(3, "0")
    messages.push({ ...user, id: messageID(index * 3), time: { created: start + index * 100 }, text: `USER-ANCHOR-${mark} ` + "user transcript line\n".repeat(4) })
    messages.push({ ...assistant, id: messageID(index * 3 + 1), time: { created: start + index * 100 + 1, completed: start + index * 100 + 2 }, content: [
      { type: "text", text: `AGENT-ANCHOR-${mark} ` + "agent transcript line\n".repeat(6) },
    ] })
    messages.push({ ...idle, id: messageID(index * 3 + 2), time: { created: start + index * 100 + 3 } })
  }
  const imported = await api<any>(e2e, "/api/experimental/session/import", {
    info: { ...original.info, id: `ses_warm_${rootID}`, title: LONG_TITLE },
    messages,
    location: { directory: e2e.workspace },
  })
  longSessionID = imported.data.id

  tui = createTui(e2e, sessionID, "warm")
  await tui.waitFor("Warm-TUI", "warm TUI did not start")
  longTui = createTui(e2e, longSessionID, "warm-search")
  await longTui.waitFor(LONG_TITLE, "session-search TUI did not start")
})

afterAll(async () => {
  await tui?.close()
  await longTui?.close()
  await e2e?.close()
  if (fixtureRoot) await rm(fixtureRoot, { recursive: true, force: true })
})

async function openPalette(current: Tui, query: string) {
  current.send(["F10"])
  await current.waitFor("Commands", "command palette did not open")
  current.type(query)
  await waitFor(async () => commandIsListed(current.pane(), query), `command is missing from the palette: ${query}`)
}

async function openSlash(current: Tui, query: string, description: string) {
  current.type(query)
  await current.waitFor(description, `slash command is missing: ${query}`)
  current.send(["Enter"])
}

function clearComposer(current: Tui, length: number) {
  current.send(["-N", String(length), "BSpace"])
}

async function submitSearch(current: Tui, message: string) {
  for (let attempt = 0; attempt < 4; attempt++) {
    current.send(["Enter"])
    try {
      await current.waitUntil(() => !current.pane().includes("Search current session"), message, 2_000)
      return
    } catch (error) {
      if (attempt === 3) throw error
      await Bun.sleep(100)
    }
  }
}

async function pressUntil(current: Tui, key: string, text: string, message: string, timeout = 5_000) {
  for (let attempt = 0; attempt < 4; attempt++) {
    current.send([key])
    try {
      await current.waitFor(text, message, timeout)
      return
    } catch (error) {
      if (attempt === 3) throw error
      await Bun.sleep(100)
    }
  }
}

async function closeNotepad(current: Tui) {
  // Always send Escape. The previous version returned when a stale capture lacked the footer,
  // leaving the panel open and breaking every later slash command in the shared TUI.
  for (let attempt = 0; attempt < 5; attempt++) {
    current.send(["Escape"])
    try {
      await current.waitUntil(
        () => !current.pane().includes("Notepad") && !current.pane().includes("esc close"),
        "notepad did not close",
        1_000,
      )
      return
    } catch {}
  }
  await current.waitUntil(
    () => !current.pane().includes("Notepad") && !current.pane().includes("esc close"),
    "notepad did not close",
  )
}

test("searches previous prompts and inserts the selected draft", async () => {
  tui.send(["F12"])
  await tui.waitFor("Search previous prompts", "prompt search dialog did not open")
  await Bun.sleep(50)
  tui.type("history-candidate")
  await tui.waitFor("history-candidate-08", "prompt search did not filter previous prompts")
  expect(tui.pane()).toContain("1. prompt")
  expect(tui.pane()).toContain("Preview")
  tui.send(["F1"])
  await tui.waitFor("close help", "prompt search help did not open")
  tui.send(["F1"])
  await tui.waitUntil(() => !tui.pane().includes("close help"), "prompt search help did not close")
  tui.send(["C-y"])
  await tui.waitFor("Copied prompt", "prompt search copy did not report success")
  tui.send(["M-y"])
  await tui.waitFor("Copied prompt details", "prompt details copy did not report success")
  tui.send(["Down", "Down"])
  tui.send(["Enter"])
  await tui.waitUntil(() => !tui.pane().includes("Search previous prompts"), "prompt search dialog did not close after selection")
  await tui.waitFor("history-candidate-06 from another session", "selected prompt was not inserted into the composer")
  clearComposer(tui, "history-candidate-06 from another session".length)
  await tui.waitUntil(() => !tui.pane().includes("history-candidate-06"), "composer was not cleared")
})

test("creates, pins, sorts and copies a note through the real notepad panel", async () => {
  await openPalette(tui, "Open notepad")
  tui.send(["Enter"])
  await tui.waitFor("No notes in Current Session yet", "empty notepad did not open")
  await Bun.sleep(75)
  tui.send(["Tab"])
  await Bun.sleep(75)
  tui.type(MARKER)
  tui.send(["Enter"])
  await tui.waitFor("session ·", "note was not scoped to the current session")
  await tui.waitFor(MARKER, "note text did not appear")
  await Bun.sleep(75)
  tui.send(["C-p"])
  await tui.waitFor("Note pinned", "note was not pinned")
  await tui.waitFor("📌 " + MARKER, "pinned note marker did not appear")
  tui.send(["C-s"])
  await tui.waitFor("sort: created", "sort mode did not change")
  tui.send(["C-y"])
  await tui.waitFor("Copied note", "copy action did not report success")
  await closeNotepad(tui)
})

test("keeps panel keys out of the composer and other dialogs", async () => {
  tui.type("aedgc")
  await tui.waitFor("aedgc", "prompt did not receive panel isolation keys")
  expect(tui.pane()).not.toContain("New note")
  expect(tui.pane()).not.toContain("Moved to")
  clearComposer(tui, 5)
  tui.send(["F10"])
  await tui.waitFor("Commands", "command palette did not open for isolation check")
  tui.type("aedgc")
  await Bun.sleep(100)
  expect(tui.pane()).not.toContain("New note")
  expect(tui.pane()).not.toContain("Moved to")
  tui.send(["Escape"])
  await tui.waitUntil(() => !tui.pane().includes("Commands"), "command palette did not close after isolation check")
  await openPalette(tui, "Open notepad")
  tui.send(["Escape"])
  await tui.waitUntil(() => !tui.pane().includes("Commands"), "command palette did not close")
  await openSlash(tui, "/notepad", "session, folder, and global notes")
  await tui.waitFor(MARKER, "note did not persist after reopening")
  expect(tui.pane()).toContain("session ·")
  await closeNotepad(tui)
})

test("edits, cancels and deletes a persisted note", async () => {
  await openSlash(tui, "/notepad", "session, folder, and global notes")
  await tui.waitFor(MARKER, "note did not reopen for editing")
  await Bun.sleep(75)
  await pressUntil(tui, "C-e", "f2 / ctrl+s save", "note editor did not reopen")
  await Bun.sleep(100)
  tui.type(" EDITED")
  await tui.waitFor(" EDITED", "edited text did not appear")
  tui.send(["F2"])
  await tui.waitFor("EDITED", "note edit was not saved")
  await Bun.sleep(75)
  await pressUntil(tui, "C-e", "f2 / ctrl+s save", "note editor did not reopen for cancel")
  await Bun.sleep(100)
  tui.send(["Escape"])
  await tui.waitUntil(() => !tui.pane().includes("f2 / ctrl+s save") && tui.pane().includes(MARKER), "cancel did not return to the note list")
  await Bun.sleep(100)
  tui.send(["C-d"])
  await tui.waitFor("Press ctrl+d again", "delete confirmation did not open")
  tui.send(["C-d"])
  await tui.waitFor("No notes in Current Session yet", "note was not deleted")
  await Bun.sleep(75)
  await closeNotepad(tui)
  await Bun.sleep(75)
})

test("encrypts text through the panel and exposes the result shortcuts", async () => {
  tui.send(["F10"])
  await tui.waitFor("Commands", "command palette did not open for encryption")
  tui.type("Encrypt sensitive data")
  await waitFor(async () => commandIsListed(tui.pane(), "Encrypt sensitive data"), "encryption command is missing")
  tui.send(["Enter"])
  await tui.waitFor("Encrypt sensitive data", "encryption panel did not open")
  await tui.waitFor("Type any text to encrypt", "text mode is not the default")
  await Bun.sleep(75)
  tui.type(SEARCH_MARKER)
  await tui.waitFor("Masked", "encryption text was not masked")
  await tui.waitUntil(
    () => tui.pane().includes("*"),
    "masked placeholders did not appear",
  )
  tui.send(["C-r"])
  await tui.waitFor("Visible", "ctrl+r did not reveal the text")
  await tui.waitFor(SEARCH_MARKER, "ctrl+r did not reveal the text")
  tui.send(["Tab"])
  tui.type(textOutput)
  await tui.waitFor(path.basename(textOutput), "text output path did not appear")
  tui.send(["Tab", "Right"])
  await tui.waitFor("Key: Encrypt", "encryption key did not switch")
  tui.send(["Enter"])
  await tui.waitFor("Encrypted with key", "enter did not encrypt the text")
  expect(tui.pane().replace(/[^A-Za-z0-9_-]+/g, "")).toContain(parsePublicKey(encryptPublicKey).kid)
  expect(tui.pane()).not.toContain(SEARCH_MARKER)
  const ciphertext = await readFile(textOutput, "utf8")
  expect(ciphertext).toStartWith("ocsec1:")
  expect(ciphertext).not.toContain(SEARCH_MARKER)
  expect(decryptEnvelope(ciphertext, encryptPrivateKey).toString("utf8")).toBe(SEARCH_MARKER)
  tui.send(["p"])
  await tui.waitFor("Copied output path", "copying the output path did not report success")
  tui.send(["c"])
  await tui.waitFor("Copied ciphertext", "copying the ciphertext did not report success")
  expect(tui.pane()).toContain("Encrypted with key")
  const copied = (tui.pane().match(/Copied (?:output path|ciphertext)/g) ?? []).length
  tui.send(["Enter"])
  await tui.waitUntil(() => !tui.pane().includes("Encrypted with key"), "enter did not copy and close the result dialog")
  tui.type("cp")
  await Bun.sleep(100)
  expect((tui.pane().match(/Copied (?:output path|ciphertext)/g) ?? []).length).toBeLessThanOrEqual(copied)
  clearComposer(tui, 2)
})

test("searches the current session dialogue, toggles roles, copies and navigates", async () => {
  longTui.send(["F11"])
  await longTui.waitFor("Search current session", "session search dialog did not open")
  await longTui.waitFor("user only", "session search did not default to user messages")
  await Bun.sleep(50)
  await longTui.waitFor("User · message start", "session result metadata did not render")
  longTui.send(["F1"])
  await longTui.waitFor("close help", "session search help did not open")
  longTui.send(["F1"])
  await longTui.waitUntil(() => !longTui.pane().includes("close help"), "session search help did not close")
  longTui.type("AGENT-ANCHOR-02")
  await longTui.waitFor("No matching dialogue", "agent text leaked into the default user-only search")
  longTui.send(["C-t"])
  await longTui.waitFor("10/10 matches", "session search did not reveal agent messages")
  longTui.type("0")
  await longTui.waitFor("1/1 matches", "session search input stopped working after toggling roles")
  await submitSearch(longTui, "session search did not close after selecting the agent match")
  await longTui.waitUntil(() => longTui.pane().includes(`AGENT-ANCHOR-${LONG_MARKER}`), "session search did not navigate to the match")

  longTui.send(["F11"])
  await longTui.waitFor("Search current session", "session search did not reopen for multi-result navigation")
  await longTui.waitFor("user only", "session search did not reset to user messages")
  await Bun.sleep(50)
  longTui.type("USER-ANCHOR-02")
  await longTui.waitFor("10/10 matches", "multi-result search did not finish")
  longTui.send(["Down", "Down", "Down"])
  longTui.send(["C-y"])
  await longTui.waitFor("Copied user message", "copy shortcut did not report success")
  await longTui.waitUntil(() => longTui.pane().includes("Search current session"), "copy closed the session search dialog")
  await submitSearch(longTui, "session search did not close after selecting a copied result")
  await longTui.waitUntil(() => longTui.pane().includes("USER-ANCHOR-026"), "arrow selection did not navigate to a multi-result match")

  longTui.send(["F11"])
  await longTui.waitFor("Search current session", "session search did not reopen before the prompt-search coexistence check")
  await Bun.sleep(50)
  longTui.send(["F12"])
  await longTui.waitFor("Search previous prompts", "session search interfered with the prompt-search shortcut")
  longTui.type("history-candidate")
  await longTui.waitFor("history-candidate-08 from another session", "prompt search did not find its original history")
  longTui.send(["Escape"])
  await longTui.waitUntil(() => !longTui.pane().includes("Search previous prompts"), "prompt search dialog did not close")
})

test("shows and enlarges a server image without exposing it to the model", async () => {
  const tool = await showImage(e2e, sessionID, imageFile)
  expect(tool.state.status).toBe("completed")
  await tui.waitFor("Image preview: warm-image.png", "inline image preview did not appear")
  await tui.waitFor("1 x 1", "image did not decode in the TUI")
  const lines = tui.pane().split("\n")
  const row = lines.findIndex((line) => line.includes("Enter/o enlarge"))
  expect(row).toBeGreaterThanOrEqual(0)
  const column = lines[row].indexOf("Enter/o enlarge") + 1
  tui.send(["-l", `\x1b[<0;${column};${row + 1}M\x1b[<0;${column};${row + 1}m`])
  await tui.waitFor("Esc to close", "image dialog did not enlarge")
  tui.send(["Escape"])
  await tui.waitUntil(() => !tui.pane().includes("Esc to close"), "image dialog did not close")
  expect(JSON.stringify(e2e.proxy.requests)).not.toContain("iVBORw0KGgo")
})
test("indexes a queued prompt while its session is busy", async () => {
  const queueSession = await createSession(e2e, "Prompt-Queue-Warm")
  const releaseFile = path.join(e2e.workspace, "queue-release.marker")
  const queuedMarker = "QUEUED_PROMPT_MARKER_WARM"
  e2e.proxy.mock.prependFixture({
    match: { userMessage: "E2E_QUEUE_BUSY", sequenceIndex: 0 },
    response: {
      toolCalls: [{
        id: "call_queue_wait",
        name: "shell",
        arguments: JSON.stringify({ command: `for i in {1..300}; do [ -f ${releaseFile} ] && break; sleep 0.1; done` }),
      }],
    },
  })
  e2e.proxy.mock.prependFixture({ match: { toolCallId: "call_queue_wait" }, response: { content: "QUEUE_RELEASED" } })

  await api(e2e, `/api/session/${queueSession}/prompt`, { text: "E2E_QUEUE_BUSY", delivery: "queue" })
  await waitFor(
    async () => e2e.proxy.mock.getRequests().some((entry) => JSON.stringify(entry.body).includes("E2E_QUEUE_BUSY")),
    "queue target did not start its busy turn",
  )
  await api(e2e, `/api/session/${queueSession}/prompt`, { text: queuedMarker, delivery: "queue" })
  await waitFor(async () => {
    const inbox = await api<{ data: Array<Record<string, any>> }>(e2e, `/api/session/${queueSession}/inbox`)
    return inbox.data.some((item) => item.type === "user" && item.payload?.text === queuedMarker)
  }, "queued prompt did not stay pending in the inbox")

  tui.send(["F12"])
  await tui.waitFor("Search previous prompts", "prompt search did not open for the queued prompt")
  await Bun.sleep(50)
  tui.type(queuedMarker)
  await tui.waitFor(queuedMarker, "queued prompt was not indexed")
  tui.send(["Escape"])
  await tui.waitUntil(() => !tui.pane().includes("Search previous prompts"), "prompt search did not close after the queued prompt check")

  await writeFile(releaseFile, "release")
  await waitFor(async () => {
    const exported = await api<{ data: { messages: Array<Record<string, any>> } }>(e2e, `/api/experimental/session/${queueSession}/export`)
    return exported.data.messages.some((message) => message.type === "user" && message.text === queuedMarker)
  }, "queued prompt was not delivered after releasing the busy turn", 60_000)
})
