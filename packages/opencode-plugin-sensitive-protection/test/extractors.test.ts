import { expect, test } from "bun:test"
import {
  extractAwsCredentials,
  extractCargoCredentials,
  extractDockerConfig,
  extractKubeconfig,
  extractNpmrc,
  extractPrivateKey,
  extractPypirc,
  extractByFormat,
  patternsForValues,
} from "../src/extractors.js"

const values = (items: readonly { value: string }[]) => items.map((item) => item.value)

test("extracts only confirmed JSON fields", () => {
  const result = extractByFormat(JSON.stringify({
    type: "oauth",
    expires: 123,
    tokens: { access_token: "ACCESS_TOKEN_123", refresh_token: "REFRESH_TOKEN_123" },
    nested: [{ id_token: "ID_TOKEN_123" }],
  }), "json", ["access_token", "refresh_token", "id_token"])
  expect(values(result)).toEqual(["ACCESS_TOKEN_123", "REFRESH_TOKEN_123", "ID_TOKEN_123"])
  expect(result).toEqual([
    { value: "ACCESS_TOKEN_123", key: "tokens.access_token" },
    { value: "REFRESH_TOKEN_123", key: "tokens.refresh_token" },
    { value: "ID_TOKEN_123", key: "nested[0].id_token" },
  ])
})

test("extracts npmrc registry tokens and decodes base64 passwords", () => {
  const result = extractNpmrc([
    "registry=https://registry.npmjs.org/",
    "//registry.npmjs.org/:_authToken=NPM_TOKEN_123",
    "//registry.npmjs.org/:_auth=dXNlcjpwYXNzd29yZA==",
    "//registry.npmjs.org/:_password=cGFzc3dvcmQxMjM=",
  ].join("\n"))
  const found = values(result)
  expect(found).toContain("NPM_TOKEN_123")
  expect(found).toContain("dXNlcjpwYXNzd29yZA==")
  expect(found).toContain("user:password")
  expect(found).toContain("password123")
  expect(found).not.toContain("https://registry.npmjs.org/")
  expect(result).toContainEqual({ value: "NPM_TOKEN_123", key: "_authToken @ registry.npmjs.org" })
  expect(result).toContainEqual({ value: "user:password", key: "_auth @ registry.npmjs.org (decoded)" })
})

test("extracts AWS secrets but not region or profile names", () => {
  const result = extractAwsCredentials([
    "[default]",
    "aws_access_key_id = AKIAEXAMPLE123456789",
    "aws_secret_access_key = SECRET_ACCESS_123456789",
    "aws_session_token = SESSION_TOKEN_123456789",
    "region = us-east-1",
  ].join("\n"))
  const found = values(result)
  expect(found).toContain("AKIAEXAMPLE123456789")
  expect(found).toContain("SECRET_ACCESS_123456789")
  expect(found).toContain("SESSION_TOKEN_123456789")
  expect(found).not.toContain("us-east-1")
  expect(found).not.toContain("default")
  expect(result).toContainEqual({ value: "SECRET_ACCESS_123456789", key: "default.aws_secret_access_key" })
})

test("extracts pypirc passwords and cargo registry tokens", () => {
  expect(values(extractPypirc("[pypi]\nusername = __token__\npassword = pypi-123456\n"))).toEqual(["pypi-123456"])
  const cargo = extractCargoCredentials([
    "[registry]",
    'token = "CARGO_TOKEN_123"',
    "[registries.private]",
    'token = "PRIVATE_TOKEN_123"',
  ].join("\n"))
  expect(values(cargo)).toEqual(["CARGO_TOKEN_123", "PRIVATE_TOKEN_123"])
  expect(cargo).toEqual([
    { value: "CARGO_TOKEN_123", key: "registry.token" },
    { value: "PRIVATE_TOKEN_123", key: "registries.private.token" },
  ])
})

test("extracts kubeconfig credentials without ordinary fields", () => {
  const result = extractKubeconfig([
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
  expect(values(result)).toEqual(["KUBE_TOKEN_123", "KUBE_PASSWORD_123", "CLIENT_KEY_DATA_123"])
  expect(result[0]).toEqual({ value: "KUBE_TOKEN_123", key: "users[developer].user.token" })
})

test("extracts Docker auth values in encoded and decoded form", () => {
  const result = extractDockerConfig(JSON.stringify({
    auths: {
      "registry.example": { auth: "dXNlcjpwYXNzd29yZA==", identitytoken: "IDENTITY_TOKEN_123" },
    },
  }))
  const found = values(result)
  expect(found).toContain("dXNlcjpwYXNzd29yZA==")
  expect(found).toContain("user:password")
  expect(found).toContain("IDENTITY_TOKEN_123")
  expect(result).toContainEqual({ value: "user:password", key: "auths.registry.example.auth (decoded)" })
})

test("extracts private key material without markers or headers", () => {
  const begin = "-----BEGIN OPENSSH PRIVATE KEY-----"
  const body = [
    "QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo=",
    "YWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXo=",
  ]
  const end = "-----END OPENSSH PRIVATE KEY-----"
  const pem = [begin, ...body, end].join("\n")
  const result = extractPrivateKey(pem)
  const found = values(result)
  expect(found).toEqual(body)
  expect(found).not.toContain(body.join(""))
  expect(found).not.toContain(begin)
  expect(found).not.toContain(end)
  expect(values(patternsForValues(result))).not.toContain(begin)
  expect(values(patternsForValues(result))).not.toContain(end)
  expect(extractPrivateKey([begin, end].join("\n"))).toEqual([])

  const encrypted = extractPrivateKey([
    "-----BEGIN RSA PRIVATE KEY-----",
    "Proc-Type: 4,ENCRYPTED",
    "DEK-Info: AES-256-CBC,0123456789ABCDEF",
    "",
    "QUJDREVGR0hJSktMTU5PUA==",
    "-----END RSA PRIVATE KEY-----",
  ].join("\n"))
  const encryptedValues = values(encrypted)
  expect(encryptedValues).toContain("QUJDREVGR0hJSktMTU5PUA==")
  expect(encryptedValues).not.toContain("Proc-Type: 4,ENCRYPTED")
  expect(encryptedValues).not.toContain("DEK-Info: AES-256-CBC,0123456789ABCDEF")

  const rfc = extractPrivateKey([
    "---- BEGIN SSH2 ENCRYPTED PRIVATE KEY ----",
    'Comment: "test@example"',
    "QUJDREVGR0hJSktMTU5PUA==",
    "---- END SSH2 ENCRYPTED PRIVATE KEY ----",
  ].join("\n"))
  const rfcValues = values(rfc)
  expect(rfcValues).toContain("QUJDREVGR0hJSktMTU5PUA==")
  expect(rfcValues).not.toContain("---- BEGIN SSH2 ENCRYPTED PRIVATE KEY ----")
  expect(rfcValues).not.toContain('Comment: "test@example"')
})

test("expands only secret values and skips placeholders", () => {
  const patterns = patternsForValues(["TOKEN_123456", "${TOKEN}", "changeme", "short"])
  const found = values(patterns)
  expect(found).toContain("TOKEN_123456")
  expect(found).not.toContain("${TOKEN}")
  expect(found).not.toContain("changeme")
  expect(found).not.toContain("short")
})
