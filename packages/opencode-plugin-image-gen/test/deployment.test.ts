import { expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { normalizePackage, prepareImageModel } from "../src/deployment.js"

test("provider package normalization does not resolve inherited object properties", () => {
  for (const name of ["constructor", "toString", "__proto__"]) expect(normalizePackage(name)).toBe(name)
  expect(normalizePackage("aisdk:@ai-sdk/openai")).toBe("@opencode/ai/providers/openai")
  expect(normalizePackage("@opencode-ai/ai/providers/openai/chat")).toBe("@opencode/ai/providers/openai/chat")
})

test("unresolved URLs introduced by native factories are rejected before HTTP", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "image-gen-deployment-"))
  try {
    const module = path.join(directory, "provider.mjs")
    await writeFile(module, `
      import {OpenAI} from ${JSON.stringify(pathToFileURL(Bun.resolveSync("@opencode/ai/providers", import.meta.dir)).href)};
      export const configure=OpenAI.configure;
      export const model=(id,settings)=>OpenAI.model(id,{...settings,baseURL:"https://example.test/"+'\u0024{UNRESOLVED_NATIVE_URL}'});
    `)
    await expect(prepareImageModel({ providerID: "custom", packageName: pathToFileURL(module).href, token: "synthetic", model: "image", prompt: "proof" })).rejects.toThrow("unresolved environment variables")
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test("custom package names containing provider keywords do not change OAuth credential mapping", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "image-gen-credential-mapping-"))
  try {
    const module = path.join(directory, "anthropic-google-vertex-provider.mjs")
    await writeFile(module, `
      import {OpenAI} from ${JSON.stringify(pathToFileURL(Bun.resolveSync("@opencode/ai/providers", import.meta.dir)).href)};
      export const configure=OpenAI.configure;
      export function model(id,settings){
        if(settings.apiKey!=="synthetic-oauth" || "authToken" in settings || "accessToken" in settings) throw new Error("Incorrect OAuth credential mapping");
        return OpenAI.model(id,settings);
      }
    `)
    await expect(prepareImageModel({ providerID: "custom", packageName: pathToFileURL(module).href, token: "synthetic-oauth", credentialType: "oauth", settings: { apiKey: "shadowed", accessToken: "shadowed", authToken: "shadowed" }, model: "image", prompt: "proof" })).resolves.toBeDefined()
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test("prepared HTTP query merges with endpoint query using the ordinary request priority", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "image-gen-query-"))
  try {
    const module = path.join(directory, "provider.mjs")
    await writeFile(module, `
      import {OpenAI} from ${JSON.stringify(pathToFileURL(Bun.resolveSync("@opencode/ai/providers", import.meta.dir)).href)};
      export const configure=OpenAI.configure;
      export const model=(id,settings)=>OpenAI.configure({...settings,
        queryParams:{routeOnly:"route",shared:"route"},http:{query:{httpOnly:"http",shared:"http"},body:settings.body}}).chat(id);
    `)
    const { model } = await prepareImageModel({ providerID: "custom", packageName: pathToFileURL(module).href, token: "synthetic", model: "image", prompt: "proof" })
    expect(model.http?.query).toEqual({ routeOnly: "route", httpOnly: "http", shared: "http" })
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test("canonical provider overrides settings for both language and image factories", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "image-gen-canonical-"))
  try {
    const module = path.join(directory, "provider.mjs")
    await writeFile(module, `
      import {OpenAI} from ${JSON.stringify(pathToFileURL(Bun.resolveSync("@opencode/ai/providers", import.meta.dir)).href)};
      function check(settings){if(settings.provider!=="canonical-tenant") throw new Error("Canonical provider missing from factory");}
      export function configure(settings){check(settings);return OpenAI.configure(settings);}
      export function model(id,settings){check(settings);return OpenAI.model(id,settings);}
    `)
    await expect(prepareImageModel({ providerID: "alias", canonical: "canonical-tenant", packageName: pathToFileURL(module).href, settings: { provider: "shadowed" }, token: "synthetic", model: "image", prompt: "proof" })).resolves.toBeDefined()
  } finally { await rm(directory, { recursive: true, force: true }) }
})
