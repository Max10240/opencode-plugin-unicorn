import { expect, test } from "bun:test"
import type { Context } from "@opencode/plugin/promise/plugin"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { setupSensitiveProtection } from "../src/index.js"

type Fixture = {
  root: string
  home: string
  data: string
  config: string
}

async function fixture(run: (fixture: Fixture) => Promise<void>) {
  const root = await mkdtemp(path.join(os.tmpdir(), "sensitive-builtins-"))
  const home = path.join(root, "home")
  const data = path.join(root, "data")
  const config = path.join(root, "config")
  await mkdir(home, { recursive: true })
  await mkdir(data, { recursive: true })
  await mkdir(config, { recursive: true })
  const previous = {
    HOME: process.env.HOME,
    XDG_DATA_HOME: process.env.XDG_DATA_HOME,
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
  }
  process.env.HOME = home
  process.env.XDG_DATA_HOME = data
  process.env.XDG_CONFIG_HOME = config
  try {
    await run({ root, home, data, config })
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    await rm(root, { recursive: true, force: true })
  }
}

async function setup(directory: string, options: Record<string, unknown>) {
  const hooks = new Map<string, (event: any) => Promise<void>>()
  const context = {
    options,
    location: { directory },
    tool: {
      transform: async (callback: (editor: any) => void) => {
        callback({ add: () => {} })
        return { dispose: async () => {} }
      },
      hook: async (name: string, callback: (event: any) => Promise<void>) => {
        hooks.set(name, callback)
        return { dispose: async () => { hooks.delete(name) } }
      },
    },
    session: {
      hook: async () => ({ dispose: async () => {} }),
    },
    command: {
      transform: async () => ({ dispose: async () => {} }),
    },
  } as unknown as Pick<Context, "options" | "location" | "tool" | "session" | "command">
  const cleanup = await setupSensitiveProtection(context)
  return { hooks, cleanup }
}

async function redact(hooks: Map<string, (event: any) => Promise<void>>, text: string) {
  const event: any = { status: "completed", tool: "shell", result: { content: [{ type: "text", text }] } }
  await hooks.get("execute.after")!(event)
  return event.result.content[0].text as string
}

test("builtins redact npmrc, AWS, and AI tokens but leave ordinary fields alone", async () => {
  await fixture(async ({ home, data, config, root }) => {
    const npmrc = path.join(home, ".npmrc")
    const aws = path.join(home, ".aws", "credentials")
    const codex = path.join(home, ".codex", "auth.json")
    await mkdir(path.dirname(aws), { recursive: true })
    await mkdir(path.dirname(codex), { recursive: true })
    await writeFile(npmrc, "//registry.npmjs.org/:_authToken=NPM_TOKEN_123\nregistry=https://registry.npmjs.org/\n")
    await writeFile(aws, "[default]\naws_access_key_id = AKIA123456789\naws_secret_access_key = SECRET_123456\nregion = us-east-1\n")
    await writeFile(codex, JSON.stringify({ OPENAI_API_KEY: "sk-codex-123456", tokens: { access_token: "ACCESS_123456", refresh_token: "REFRESH_123456" } }))

    const { hooks, cleanup } = await setup(root, { builtins: true, notifications: false, maxContentBytes: 100_000 })
    try {
      await expect(hooks.get("execute.before")!({ tool: "read", input: { path: npmrc } })).resolves.toBeUndefined()
      const npm = await redact(hooks, "prefix NPM_TOKEN_123 suffix")
      expect(npm).toContain("[REDACTED:PROTECTED]")
      expect(npm).not.toContain("NPM_TOKEN_123")

      const awsText = await redact(hooks, "AWS SECRET_123456 in us-east-1")
      expect(awsText).not.toContain("SECRET_123456")
      expect(awsText).toContain("us-east-1")

      const codexText = await redact(hooks, "AI sk-codex-123456 ACCESS_123456 REFRESH_123456")
      expect(codexText).not.toContain("sk-codex-123456")
      expect(codexText).not.toContain("ACCESS_123456")
      expect(codexText).not.toContain("REFRESH_123456")
      expect(codexText).toContain("AI")
    } finally {
      await cleanup()
    }
  })
})

test("SSH private keys are blocked for read, edit, and write", async () => {
  await fixture(async ({ home, root }) => {
    const ssh = path.join(home, ".ssh", "id_ed25519")
    await mkdir(path.dirname(ssh), { recursive: true })
    await writeFile(ssh, "-----BEGIN OPENSSH PRIVATE KEY-----\nPRIVATE_KEY_MATERIAL_123\n-----END OPENSSH PRIVATE KEY-----\n")
    const { hooks, cleanup } = await setup(root, { builtins: true, notifications: false })
    try {
      await expect(hooks.get("execute.before")!({ tool: "read", input: { path: ssh } })).rejects.toThrow("Blocked")
      await expect(hooks.get("execute.before")!({ tool: "edit", input: { path: ssh } })).rejects.toThrow("Blocked")
      await expect(hooks.get("execute.before")!({ tool: "write", input: { path: ssh } })).rejects.toThrow("Blocked")
    } finally {
      await cleanup()
    }
  })
})

test("SSH private key markers and headers are not redacted as secrets", async () => {
  await fixture(async ({ home, root }) => {
    const ssh = path.join(home, ".ssh", "id_ed25519")
    await mkdir(path.dirname(ssh), { recursive: true })
    const begin = ["-----BEGIN", "OPENSSH", "PRIVATE KEY-----"].join(" ")
    const end = ["-----END", "OPENSSH", "PRIVATE KEY-----"].join(" ")
    const body = ["QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo=", "YWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXo="]
    await writeFile(ssh, `${begin}\n${body.join("\n")}\n${end}\n`)
    const { hooks, cleanup } = await setup(root, { builtins: true, notifications: false })
    try {
      expect(await redact(hooks, begin)).toBe(begin)
      expect(await redact(hooks, end)).toBe(end)
      const joined = await redact(hooks, body.join(""))
      for (const line of body) expect(joined).not.toContain(line)
      expect(joined).toContain("[REDACTED:PROTECTED]")
    } finally {
      await cleanup()
    }
  })
})

test("disabled builtin groups and changed files are respected", async () => {
  await fixture(async ({ home, root }) => {
    const ssh = path.join(home, ".ssh", "id_ed25519")
    const npmrc = path.join(home, ".npmrc")
    await mkdir(path.dirname(ssh), { recursive: true })
    await writeFile(ssh, "-----BEGIN OPENSSH PRIVATE KEY-----\nKEY\n-----END OPENSSH PRIVATE KEY-----\n")
    await writeFile(npmrc, "//registry.npmjs.org/:_authToken=OLD_TOKEN_123\n")

    const disabled = await setup(root, { builtins: true, disabledBuiltinGroups: ["sshKeys"], notifications: false })
    try {
      await expect(disabled.hooks.get("execute.before")!({ tool: "read", input: { path: ssh } })).resolves.toBeUndefined()
    } finally {
      await disabled.cleanup()
    }

    const { hooks, cleanup } = await setup(root, { builtins: true, notifications: false })
    try {
      expect(await redact(hooks, "OLD_TOKEN_123")).not.toContain("OLD_TOKEN_123")
      await writeFile(npmrc, "//registry.npmjs.org/:_authToken=NEW_TOKEN_456\n")
      const deadline = Date.now() + 3_000
      let text = ""
      while (Date.now() < deadline) {
        await Bun.sleep(100)
        text = await redact(hooks, "NEW_TOKEN_456")
        if (!text.includes("NEW_TOKEN_456")) break
      }
      expect(text).not.toContain("NEW_TOKEN_456")
    } finally {
      await cleanup()
    }
  })
})
