import { expect, test } from "bun:test"
import { extractContent, privateKeyValues, toJsonPath } from "../src/spec.js"

test("JSON selectors handle nested objects, arrays, and string arrays", () => {
  const content = JSON.stringify({
    auth: { token: "AUTH_TOKEN_123" },
    servers: [{ password: "SERVER_ONE_123" }, { password: "SERVER_TWO_123" }],
    tokens: ["ARRAY_TOKEN_1", "ARRAY_TOKEN_2"],
  })
  const result = extractContent(content, "json", ["auth.token", "servers[].password", "tokens[]"], { strict: true })
  expect(result.missing).toEqual([])
  expect(result.values.map((value) => value.value)).toEqual([
    "AUTH_TOKEN_123",
    "SERVER_ONE_123",
    "SERVER_TWO_123",
    "ARRAY_TOKEN_1",
    "ARRAY_TOKEN_2",
  ])
})

test("YAML, TOML, and INI use the same selector engine", () => {
  const yaml = "servers:\n  - password: YAML_ONE_123\n  - password: YAML_TWO_123\n"
  expect(extractContent(yaml, "yaml", ["servers[].password"], { strict: true }).values.map((value) => value.value))
    .toEqual(["YAML_ONE_123", "YAML_TWO_123"])

  const toml = "[[servers]]\npassword = \"TOML_ONE_123\"\n[[servers]]\npassword = \"TOML_TWO_123\"\n"
  expect(extractContent(toml, "toml", ["servers[].password"], { strict: true }).values.map((value) => value.value))
    .toEqual(["TOML_ONE_123", "TOML_TWO_123"])

  const ini = "[server.a]\npassword=INI_ONE_123\n[server.b]\npassword=INI_TWO_123\n"
  expect(extractContent(ini, "ini", ["server.*.password"], { strict: true }).values.map((value) => value.value))
    .toEqual(["INI_ONE_123", "INI_TWO_123"])
})

test("key globs match INI registry keys", () => {
  const content = "//registry.npmjs.org/:_authToken=NPM_TOKEN_123\n"
  const result = extractContent(content, "ini", ["*_authToken"], { strict: true })
  expect(result.values).toEqual([{ value: "NPM_TOKEN_123", key: "*_authToken" }])
})

test("missing selectors are all reported", () => {
  const result = extractContent(JSON.stringify({ auth: { token: "TOKEN_123" } }), "json", [
    "auth.token",
    "servers[].password",
    "clients[].secret",
  ], { strict: true })
  expect(result.missing).toEqual(["servers[].password", "clients[].secret"])
  expect(result.available).toContain("auth.token")
})

test("private keys expose only the body", () => {
  const begin = "-----BEGIN OPENSSH PRIVATE KEY-----"
  const end = "-----END OPENSSH PRIVATE KEY-----"
  const values = privateKeyValues(`${begin}\nBODY_ONE_123\nBODY_TWO_123\n${end}\n`)
  expect(values).toContainEqual({ value: "BODY_ONE_123\nBODY_TWO_123", key: "private key body" })
  expect(values).toContainEqual({ value: "BODY_ONE_123", key: "private key line" })
  expect(values).toContainEqual({ value: "BODY_TWO_123", key: "private key line" })
  expect(JSON.stringify(values)).not.toContain(begin)
  expect(JSON.stringify(values)).not.toContain(end)
})

test("public selectors translate to JSONPath", () => {
  expect(toJsonPath("auth.token")).toBe("$[\"auth\"][\"token\"]")
  expect(toJsonPath("servers[].password")).toBe("$[\"servers\"][*][\"password\"]")
  expect(toJsonPath("servers[*].password")).toBe("$[\"servers\"][*][\"password\"]")
  expect(toJsonPath("servers[0].password")).toBe("$[\"servers\"][0][\"password\"]")
  expect(toJsonPath("tokens[]")).toBe("$[\"tokens\"][*]")
})
