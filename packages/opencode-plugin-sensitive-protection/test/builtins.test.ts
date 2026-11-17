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
  await fixture(async ({ home, root }) => {
    const npmrc = path.join(home, ".npmrc")
    const aws = path.join(home, ".aws", "credentials")
    const codex = path.join(home, ".codex", "auth.json")
    await mkdir(path.dirname(aws), { recursive: true })
    await mkdir(path.dirname(codex), { recursive: true })
    await writeFile(npmrc, "//registry.npmjs.org/:_authToken=NPM_TOKEN_123\nregistry=https://registry.npmjs.org/\n")
    await writeFile(aws, "[default]\naws_access_key_id = AKIA123456789\naws_secret_access_key = SECRET_123456\nregion = us-east-1\n")
    await writeFile(codex, JSON.stringify({ OPENAI_API_KEY: "sk-codex-123456", tokens: { access_token: "ACCESS_123456", refresh_token: "REFRESH_123456" } }))

    const { hooks, cleanup } = await setup(root, { notifications: false, maxContentBytes: 100_000 })
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

test("private keys redact only the key body and not the markers", async () => {
  await fixture(async ({ home, root }) => {
    const ssh = path.join(home, ".ssh", "id_ed25519")
    await mkdir(path.dirname(ssh), { recursive: true })
    const begin = ["-----BEGIN", "OPENSSH", "PRIVATE KEY-----"].join(" ")
    const end = ["-----END", "OPENSSH", "PRIVATE KEY-----"].join(" ")
    const body = ["QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo=", "YWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXo="]
    await writeFile(ssh, `${begin}\n${body.join("\n")}\n${end}\n`)
    const { hooks, cleanup } = await setup(root, { notifications: false })
    try {
      await expect(hooks.get("execute.before")!({ tool: "read", input: { path: ssh } })).resolves.toBeUndefined()
      expect(await redact(hooks, begin)).toBe(begin)
      expect(await redact(hooks, end)).toBe(end)
      const joined = await redact(hooks, body.join("\n"))
      expect(joined).not.toContain(body[0]!)
      expect(joined).not.toContain(body[1]!)
      expect(joined).toContain("[REDACTED:PROTECTED]")
    } finally {
      await cleanup()
    }
  })
})

test("exclusions remove default files at the source", async () => {
  await fixture(async ({ home, root }) => {
    const npmrc = path.join(home, ".npmrc")
    await writeFile(npmrc, "//registry.npmjs.org/:_authToken=NPM_TOKEN_123\n")
    const { hooks, cleanup } = await setup(root, {
      notifications: false,
      files: ["!~/.npmrc"],
    })
    try {
      expect(await redact(hooks, "NPM_TOKEN_123")).toBe("NPM_TOKEN_123")
    } finally {
      await cleanup()
    }
  })
})

test("structured config files use fields and reject missing keys", async () => {
  await fixture(async ({ root }) => {
    const file = path.join(root, "settings.json")
    await writeFile(file, JSON.stringify({ auth: { token: "CONFIG_TOKEN_123" }, servers: [{ password: "SERVER_PASSWORD_1" }] }))
    const { hooks, cleanup } = await setup(root, {
      notifications: false,
      files: [{
        path: file,
        format: "json",
        keys: ["auth.token", "servers[].password"],
      }],
    })
    try {
      const text = await redact(hooks, "CONFIG_TOKEN_123 SERVER_PASSWORD_1 ordinary")
      expect(text).toBe("[REDACTED:PROTECTED] [REDACTED:PROTECTED] ordinary")
    } finally {
      await cleanup()
    }
  })

  await fixture(async ({ root }) => {
    const file = path.join(root, "settings.json")
    await writeFile(file, JSON.stringify({ auth: { token: "CONFIG_TOKEN_123" } }))
    const { hooks, cleanup } = await setup(root, {
      notifications: false,
      files: [{
        path: file,
        format: "json",
        keys: ["auth.missing", "servers[].password"],
      }],
    })
    try {
      await expect(hooks.get("execute.before")!({ tool: "read", input: { path: file } })).rejects.toThrow("Blocked")
    } finally {
      await cleanup()
    }
  })
})

test("default files without secrets are not blocked", async () => {
  await fixture(async ({ home, root }) => {
    const npmrc = path.join(home, ".npmrc")
    await writeFile(npmrc, "registry=https://registry.npmjs.org/\n")
    const { hooks, cleanup } = await setup(root, { notifications: false })
    try {
      await expect(hooks.get("execute.before")!({ tool: "read", input: { path: npmrc } })).resolves.toBeUndefined()
      expect(await redact(hooks, "registry=https://registry.npmjs.org/")).toBe("registry=https://registry.npmjs.org/")
    } finally {
      await cleanup()
    }
  })
})
