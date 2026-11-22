import { expect, setDefaultTimeout, test } from "bun:test"
import { writeFile } from "node:fs/promises"
import path from "node:path"
import { createOpenCodeE2E } from "../../opencode-plugin-unicorn/test/e2e-utils.js"
import { createSession } from "../../opencode-plugin-show-img/test/e2e-utils.js"
import { createTui } from "../../../test/tui-support.js"

setDefaultTimeout(180_000)

const PACKAGE_ROOT = path.resolve(import.meta.dir, "../../opencode-plugin-unicorn")

async function startNotepad() {
  if (Bun.spawnSync(["tmux", "-V"]).exitCode !== 0) throw new Error("tmux is required for this E2E test")
  const e2e = await createOpenCodeE2E({
    plugin: "unicorn",
    pluginPackage: PACKAGE_ROOT,
    pluginOptions: { notepad: { keybind: false } },
  })
  try {
    await writeFile(path.join(e2e.configDirectory, "cli.json"), `${JSON.stringify({
      plugins: [{ package: PACKAGE_ROOT, options: { notepad: { keybind: false } } }],
    }, null, 2)}\n`)
    const sessionID = await createSession(e2e, "Notepad-TUI-E2E")
    const tui = createTui(e2e, sessionID, "notepad-tui", { width: 160, height: 48 })
    await tui.waitFor("Notepad-TUI-E2E", "the TUI did not start")
    await Bun.sleep(1_000)
    await tui.waitFor("Compaction-E2e · GPT-5.6 Luna", "session agent and model did not settle", 30_000)
    await openNotepad(tui)
    return { e2e, tui }
  } catch (error) {
    await e2e.close()
    throw error
  }
}

async function openNotepad(tui: Awaited<ReturnType<typeof startNotepad>>["tui"]) {
  tui.type("/notepad")
  await tui.waitFor("session, folder, and global notes", "the notepad command did not appear", 10_000)
  tui.send(["Enter"])
  await tui.waitFor("Search in Current Session", "the notepad panel did not open")
  await Bun.sleep(300)
}

function promptRequest(e2e: Awaited<ReturnType<typeof startNotepad>>["e2e"], text: string) {
  return e2e.proxy.requests.findLast((request) => JSON.stringify(request.messages).includes(text))
}

async function sendPrompt(
  e2e: Awaited<ReturnType<typeof startNotepad>>["e2e"],
  tui: Awaited<ReturnType<typeof startNotepad>>["tui"],
  text: string,
) {
  tui.type(text)
  tui.send(["Enter"])
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    const request = promptRequest(e2e, text)
    if (request) return request
    await Bun.sleep(50)
  }
  throw new Error(`the mock provider did not receive ${text}\n${tui.pane()}`)
}

test.serial("quick create, scope switching, placeholders, and list navigation", async () => {
  const { e2e, tui } = await startNotepad()
  try {
    expect(tui.pane()).toContain("Search in Current Session")
    expect(tui.pane()).toContain("New note in Current Session")
    expect(tui.pane()).toContain("ctrl+a Current Session")

    // Search Enter is intentionally unbound and must not open the editor.
    tui.send(["Enter"])
    await Bun.sleep(300)
    expect(tui.pane()).not.toContain("Edit note")

    // The search box starts focused and printable characters filter the list.
    tui.type("NOTE")
    await tui.waitFor("No notes match in Current Session", "typing did not filter the list")
    tui.send(["BSpace", "BSpace", "BSpace", "BSpace"])
    await tui.waitFor("No notes in Current Session yet", "clearing the search did not restore the empty state")

    // Tab moves to the create box. Alt+Enter inserts a line, Enter creates.
    tui.send(["Tab"])
    await Bun.sleep(100)
    tui.type("SESSION_NOTE_ALPHA")
    tui.send(["M-Enter"])
    tui.type("SECOND_LINE")
    tui.send(["Enter"])
    await Bun.sleep(300)
    await tui.waitFor("session ·", "enter in the create box did not create a note")
    expect(tui.pane()).not.toContain("Edit note")

    // Keep text in both boxes, then switch scope. Ctrl+A must not act as select-all.
    tui.send(["Tab"])
    await Bun.sleep(100)
    tui.type("NOTE")
    tui.send(["Tab"])
    await Bun.sleep(100)
    tui.type("DIRECTORY_NOTE_BETA")
    tui.send(["C-a"])
    await tui.waitFor("ctrl+a Current Directory", "ctrl+a did not switch to the current directory")
    expect(tui.pane()).toContain("DIRECTORY_NOTE_BETA")
    tui.type("!")
    await tui.waitFor("DIRECTORY_NOTE_BETA!", "ctrl+a replaced the create text instead of switching scope")
    tui.send(["Enter"])
    await tui.waitFor("directory ·", "the directory note was not created")

    // Clearing the search reveals placeholders that follow the scope.
    tui.send(["Tab"])
    await Bun.sleep(100)
    tui.send(["BSpace", "BSpace", "BSpace", "BSpace"])
    await tui.waitFor("Search in Current Directory", "the search placeholder did not follow the scope")
    expect(tui.pane()).toContain("New note in Current Directory")

    tui.send(["C-a"])
    await tui.waitFor("ctrl+a Global", "ctrl+a did not switch to global")
    await tui.waitFor("Search in Global", "the search placeholder did not switch to global")
    expect(tui.pane()).toContain("New note in Global")
    expect(tui.pane()).not.toContain("SESSION_NOTE_ALPHA SECOND_LINE")
    expect(tui.pane()).not.toContain("DIRECTORY_NOTE_BETA!")

    tui.send(["Tab"])
    await Bun.sleep(100)
    tui.type("GLOBAL_NOTE_GAMMA")
    tui.send(["Enter"])
    await tui.waitFor("global ·", "the global note was not created")

    // Back to the session scope; only the session note is visible.
    tui.send(["C-a"])
    await tui.waitFor("ctrl+a Current Session", "ctrl+a did not return to the session scope")
    await tui.waitFor("SESSION_NOTE_ALPHA SECOND_LINE", "the session note did not return")
    await Bun.sleep(200)
    expect(tui.pane()).not.toContain("GLOBAL_NOTE_GAMMA")
    expect(tui.pane()).not.toContain("DIRECTORY_NOTE_BETA!")

    // A new note is selected first; Down moves to the older note.
    tui.type("SESSION_NOTE_DELTA")
    tui.send(["Enter"])
    await Bun.sleep(300)
    await tui.waitFor("SESSION_NOTE_DELTA", "the second session note was not created")
    tui.send(["Down"])
    tui.send(["C-d"])
    await tui.waitFor("Press ctrl+d again", "the first Ctrl+D did not request confirmation")
    tui.send(["C-d"])
    await tui.waitFor("SESSION_NOTE_DELTA", "the list did not keep the other session note")
    await tui.waitUntil(() => !tui.pane().includes("SESSION_NOTE_ALPHA SECOND_LINE"), "Down did not select the older note")
    tui.send(["C-z"])
    await tui.waitFor("SESSION_NOTE_ALPHA SECOND_LINE", "undo did not restore the deleted note")
  } finally {
    tui.close()
    await e2e.close()
  }
})

test.serial("goal note is first, protected, and injected into session context", async () => {
  const { e2e, tui } = await startNotepad()
  try {
    // Create the first session note and make it the goal.
    tui.send(["Tab"])
    await Bun.sleep(100)
    tui.type("GOAL_CONTEXT_ALPHA")
    tui.send(["Enter"])
    await Bun.sleep(300)
    await tui.waitFor("session ·", "the goal note was not created")
    tui.send(["C-t"])
    await tui.waitFor("🎯 GOAL_CONTEXT_ALPHA", "ctrl+t did not mark the goal")
    await tui.waitFor("goal · session", "the goal metadata did not render")

    // A goal note cannot be deleted until Ctrl+T clears the goal.
    tui.send(["C-d"])
    await tui.waitFor("Goal note cannot be deleted", "goal deletion was not blocked")
    expect(tui.pane()).toContain("GOAL_CONTEXT_ALPHA")
    expect(tui.pane()).not.toContain("Press ctrl+d again")

    // The goal stays first even when the search query does not match it.
    tui.type("OTHER_CONTEXT_BETA")
    tui.send(["Enter"])
    await Bun.sleep(300)
    await tui.waitFor("OTHER_CONTEXT_BETA", "the second note was not created")
    tui.send(["Tab"])
    await Bun.sleep(100)
    tui.type("NO_MATCH_QUERY")
    await Bun.sleep(200)
    expect(tui.pane()).toContain("GOAL_CONTEXT_ALPHA")
    expect(tui.pane()).not.toContain("OTHER_CONTEXT_BETA")
    tui.send(["BSpace", "BSpace", "BSpace", "BSpace", "BSpace", "BSpace", "BSpace", "BSpace", "BSpace", "BSpace", "BSpace", "BSpace", "BSpace", "BSpace"])
    await tui.waitFor("Search in Current Session", "clearing the search did not restore the placeholder")

    // The goal reaches the next model request as session context.
    tui.send(["Escape"])
    await Bun.sleep(300)
    const first = await sendPrompt(e2e, tui, "GOAL_TEST_PROMPT")
    expect(first).toBeDefined()
    const firstPayload = JSON.stringify(first?.messages)
    expect(firstPayload).toContain("GOAL_CONTEXT_ALPHA")
    expect(firstPayload).toContain("notepad.goal")

    // Replace the goal and check the supersede notice on the next request.
    await openNotepad(tui)
    await tui.waitFor("🎯 GOAL_CONTEXT_ALPHA", "the goal did not survive reopening")
    tui.send(["Down"])
    tui.send(["C-t"])
    await tui.waitFor("🎯 OTHER_CONTEXT_BETA", "the second note did not become the goal")
    expect(tui.pane()).not.toContain("🎯 GOAL_CONTEXT_ALPHA")

    // The goal shortcut is disabled in Global, so Ctrl+T leaves the goal intact.
    tui.send(["C-a"])
    tui.send(["C-a"])
    await tui.waitFor("ctrl+a Global", "scope did not reach global")
    tui.send(["C-t"])
    await Bun.sleep(300)
    expect(tui.pane()).toContain("🎯 OTHER_CONTEXT_BETA")
    tui.send(["C-a"])
    await tui.waitFor("ctrl+a Current Session", "scope did not return to the session")

    tui.send(["Escape"])
    await Bun.sleep(300)
    const second = await sendPrompt(e2e, tui, "GOAL_TEST_PROMPT_2")
    expect(second).toBeDefined()
    const secondPayload = JSON.stringify(second?.messages)
    expect(secondPayload).toContain("OTHER_CONTEXT_BETA")
    expect(secondPayload).toContain("changed and supersedes the previous value")
    expect(secondPayload).toContain("notepad.goal")

    // Clearing the goal makes deletion possible again.
    await openNotepad(tui)
    await tui.waitFor("🎯 OTHER_CONTEXT_BETA", "the goal did not survive the second reopening")
    tui.send(["C-t"])
    await tui.waitUntil(() => !tui.pane().includes("🎯 OTHER_CONTEXT_BETA"), "ctrl+t did not clear the goal")
    tui.send(["C-d"])
    await tui.waitFor("Press ctrl+d again", "the note was not deletable after clearing the goal")
    tui.send(["C-d"])
    await tui.waitUntil(() => !tui.pane().includes("OTHER_CONTEXT_BETA"), "the note was not deleted")
  } finally {
    tui.close()
    await e2e.close()
  }
})
