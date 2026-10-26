import { expect, test } from "bun:test"
import { createPublicKey, generateKeyPairSync } from "node:crypto"
import {
  decryptEnvelope,
  encryptEnvelope,
  ENVELOPE_PREFIX,
  parsePublicKey,
  publicKeyFingerprint,
} from "../src/crypto.js"

function pair(bits = 2048) {
  return generateKeyPairSync("rsa", {
    modulusLength: bits,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  })
}

function envelope(publicKeyPem: string, text = "SECRET_MARKER") {
  return encryptEnvelope(parsePublicKey(publicKeyPem), Buffer.from(text))
}

function mutate(value: string, change: (body: Record<string, any>) => void) {
  const body = JSON.parse(Buffer.from(value.slice(ENVELOPE_PREFIX.length), "base64url").toString("utf8"))
  change(body)
  return `${ENVELOPE_PREFIX}${Buffer.from(JSON.stringify(body)).toString("base64url")}`
}

test("parses PEM and base64 DER public keys and rejects private or weak keys", () => {
  const keys = pair()
  const pem = parsePublicKey(keys.publicKey)
  const der = createPublicKey(keys.publicKey).export({ type: "spki", format: "der" }).toString("base64")
  const decoded = parsePublicKey(der)
  expect(pem.kid).toBe(publicKeyFingerprint(pem.key))
  expect(decoded.kid).toBe(pem.kid)
  expect(pem.kid).toMatch(/^[A-Za-z0-9_-]{43}$/)

  for (const value of [keys.privateKey, "not a public key", ""]) {
    expect(() => parsePublicKey(value)).toThrow()
  }
  expect(() => parsePublicKey(pair(1024).publicKey)).toThrow("at least")
  expect(() => parsePublicKey(generateKeyPairSync("ec", {
    namedCurve: "prime256v1",
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  }).publicKey)).toThrow("RSA")
})

test("round-trips arbitrary bytes with a fresh IV and the public key fingerprint", () => {
  const keys = pair()
  for (const data of [Buffer.alloc(0), Buffer.from("SECRET_MARKER"), crypto.getRandomValues(new Uint8Array(4096))]) {
    const first = encryptEnvelope(parsePublicKey(keys.publicKey), Buffer.from(data))
    const second = encryptEnvelope(parsePublicKey(keys.publicKey), Buffer.from(data))
    expect(first).toStartWith(ENVELOPE_PREFIX)
    expect(first).not.toBe(second)
    expect(decryptEnvelope(first, keys.privateKey)).toEqual(Buffer.from(data))
    expect(decryptEnvelope(second, keys.privateKey)).toEqual(Buffer.from(data))
  }
})

test("rejects the wrong private key and every changed authenticated field", () => {
  const keys = pair()
  const other = pair()
  const valid = envelope(keys.publicKey)
  expect(() => decryptEnvelope(valid, other.privateKey)).toThrow("does not match")

  for (const change of [
    (body: Record<string, any>) => { body.v = 2 },
    (body: Record<string, any>) => { body.alg = "A256GCM" },
    (body: Record<string, any>) => { body.kid = other.publicKey },
    (body: Record<string, any>) => { body.ek = Buffer.from("changed").toString("base64url") },
    (body: Record<string, any>) => { body.iv = Buffer.alloc(12).toString("base64url") },
    (body: Record<string, any>) => { body.ct = Buffer.from("changed").toString("base64url") },
    (body: Record<string, any>) => { body.tag = Buffer.alloc(16).toString("base64url") },
  ]) expect(() => decryptEnvelope(mutate(valid, change), keys.privateKey)).toThrow()

  for (const value of ["", "ocsec1:not-json", "ocsec1:", "other:value"]) {
    expect(() => decryptEnvelope(value, keys.privateKey)).toThrow()
  }
})

test("does not treat a private key or private DER as a public key", () => {
  const keys = pair()
  const privateDer = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "der" },
  }).privateKey
  expect(() => parsePublicKey(keys.privateKey)).toThrow("private key")
  expect(() => parsePublicKey(privateDer.toString("base64"))).toThrow("private key")
})
