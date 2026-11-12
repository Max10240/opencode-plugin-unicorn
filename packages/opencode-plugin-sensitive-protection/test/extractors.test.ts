import { expect, test } from "bun:test"
import {
  extractAwsCredentials,
  extractCargoCredentials,
  extractDockerConfig,
  extractKubeconfig,
  extractNpmrc,
  extractPypirc,
  extractByFormat,
  patternsForValues,
} from "../src/extractors.js"

test("extracts only confirmed JSON fields", () => {
  const values = extractByFormat(JSON.stringify({
    type: "oauth",
    expires: 123,
    tokens: { access_token: "ACCESS_TOKEN_123", refresh_token: "REFRESH_TOKEN_123" },
    nested: [{ id_token: "ID_TOKEN_123" }],
  }), "json", ["access_token", "refresh_token", "id_token"])
  expect(values).toEqual(["ACCESS_TOKEN_123", "REFRESH_TOKEN_123", "ID_TOKEN_123"])
})

test("extracts npmrc registry tokens and decodes base64 passwords", () => {
  const values = extractNpmrc([
    "registry=https://registry.npmjs.org/",
    "//registry.npmjs.org/:_authToken=NPM_TOKEN_123",
    "//registry.npmjs.org/:_auth=dXNlcjpwYXNzd29yZA==",
    "//registry.npmjs.org/:_password=cGFzc3dvcmQxMjM=",
  ].join("\n"))
  expect(values).toContain("NPM_TOKEN_123")
  expect(values).toContain("dXNlcjpwYXNzd29yZA==")
  expect(values).toContain("user:password")
  expect(values).toContain("password123")
  expect(values).not.toContain("https://registry.npmjs.org/")
})

test("extracts AWS secrets but not region or profile names", () => {
  const values = extractAwsCredentials([
    "[default]",
    "aws_access_key_id = AKIAEXAMPLE123456789",
    "aws_secret_access_key = SECRET_ACCESS_123456789",
    "aws_session_token = SESSION_TOKEN_123456789",
    "region = us-east-1",
  ].join("\n"))
  expect(values).toContain("AKIAEXAMPLE123456789")
  expect(values).toContain("SECRET_ACCESS_123456789")
  expect(values).toContain("SESSION_TOKEN_123456789")
  expect(values).not.toContain("us-east-1")
  expect(values).not.toContain("default")
})

test("extracts pypirc passwords and cargo registry tokens", () => {
  expect(extractPypirc("[pypi]\nusername = __token__\npassword = pypi-123456\n")).toEqual(["pypi-123456"])
  expect(extractCargoCredentials([
    "[registry]",
    'token = "CARGO_TOKEN_123"',
    "[registries.private]",
    'token = "PRIVATE_TOKEN_123"',
  ].join("\n"))).toEqual(["CARGO_TOKEN_123", "PRIVATE_TOKEN_123"])
})

test("extracts kubeconfig credentials without ordinary fields", () => {
  const values = extractKubeconfig([
    "users:",
    "  - name: developer",
    "    user:",
    "      token: KUBE_TOKEN_123",
    "      password: KUBE_PASSWORD_123",
    "      client-key-data: CLIENT_KEY_DATA_123",
    "      client-certificate-data: PUBLIC_CERT_DATA",
    "clusters:",
    "  - name: dev",
    "    cluster:",
    "      server: https://example.test",
  ].join("\n"))
  expect(values).toEqual(["KUBE_TOKEN_123", "KUBE_PASSWORD_123", "CLIENT_KEY_DATA_123"])
})

test("extracts Docker auth values in encoded and decoded form", () => {
  const values = extractDockerConfig(JSON.stringify({
    auths: {
      "registry.example": { auth: "dXNlcjpwYXNzd29yZA==", identitytoken: "IDENTITY_TOKEN_123" },
    },
  }))
  expect(values).toContain("dXNlcjpwYXNzd29yZA==")
  expect(values).toContain("user:password")
  expect(values).toContain("IDENTITY_TOKEN_123")
})

test("expands only secret values and skips placeholders", () => {
  const patterns = patternsForValues(["TOKEN_123456", "${TOKEN}", "changeme", "short"])
  expect(patterns).toContain("TOKEN_123456")
  expect(patterns).not.toContain("${TOKEN}")
  expect(patterns).not.toContain("changeme")
  expect(patterns).not.toContain("short")
})
