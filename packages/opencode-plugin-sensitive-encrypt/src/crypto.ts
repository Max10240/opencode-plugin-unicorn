import {
  constants,
  createCipheriv,
  createDecipheriv,
  createHash,
  createPrivateKey,
  createPublicKey,
  privateDecrypt,
  publicEncrypt,
  randomBytes,
  type KeyObject,
} from "node:crypto"

export const ENVELOPE_PREFIX = "ocsec1:"
export const ENVELOPE_VERSION = 1
export const ENVELOPE_ALGORITHM = "RSA-OAEP-256+A256GCM"
export const MIN_RSA_BITS = 2048
export const MAX_RSA_BITS = 8192

export type ParsedPublicKey = {
  readonly key: KeyObject
  readonly kid: string
}

type Envelope = {
  readonly v: number
  readonly alg: string
  readonly kid: string
  readonly ek: string
  readonly iv: string
  readonly ct: string
  readonly tag: string
}

function isPrivatePem(value: string) {
  return /-----BEGIN (?:ENCRYPTED )?(?:RSA )?PRIVATE KEY-----/.test(value)
}

function isPrivateDer(value: Buffer) {
  for (const type of ["pkcs8", "pkcs1"] as const) {
    try {
      createPrivateKey({ key: value, format: "der", type })
      return true
    } catch {
      // Not this private-key format.
    }
  }
  return false
}

export function parsePublicKey(value: string): ParsedPublicKey {
  const text = value.trim()
  if (!text) throw new Error("Public key is empty")
  if (isPrivatePem(text)) throw new Error("Expected a public key, not a private key")

  let key: KeyObject
  if (text.includes("-----BEGIN")) {
    key = createPublicKey({ key: text, format: "pem" })
  } else {
    const der = Buffer.from(text.replace(/\s+/g, ""), "base64")
    if (!der.length) throw new Error("Public key is empty")
    if (isPrivateDer(der)) throw new Error("Expected a public key, not a private key")
    try {
      key = createPublicKey({ key: der, format: "der", type: "spki" })
    } catch {
      key = createPublicKey({ key: der, format: "der", type: "pkcs1" })
    }
  }

  if (key.asymmetricKeyType !== "rsa") throw new Error("Public key must be RSA")
  const bits = key.asymmetricKeyDetails?.modulusLength ?? 0
  if (bits < MIN_RSA_BITS) throw new Error(`RSA public key must be at least ${MIN_RSA_BITS} bits`)
  if (bits > MAX_RSA_BITS) throw new Error(`RSA public key must be at most ${MAX_RSA_BITS} bits`)

  const kid = createHash("sha256")
    .update(key.export({ type: "spki", format: "der" }))
    .digest("base64url")
  return { key, kid }
}

export function publicKeyFingerprint(key: KeyObject) {
  return createHash("sha256")
    .update(key.export({ type: "spki", format: "der" }))
    .digest("base64url")
}

function aad(kid: string) {
  return Buffer.from(JSON.stringify({ v: ENVELOPE_VERSION, alg: ENVELOPE_ALGORITHM, kid }))
}

export function encryptEnvelope(publicKey: ParsedPublicKey, plaintext: Buffer): string {
  const aesKey = randomBytes(32)
  const iv = randomBytes(12)
  const cipher = createCipheriv("aes-256-gcm", aesKey, iv, { authTagLength: 16 })
  cipher.setAAD(aad(publicKey.kid))
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()])
  const tag = cipher.getAuthTag()
  const ek = publicEncrypt(
    {
      key: publicKey.key,
      padding: constants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: "sha256",
    },
    aesKey,
  )
  const envelope: Envelope = {
    v: ENVELOPE_VERSION,
    alg: ENVELOPE_ALGORITHM,
    kid: publicKey.kid,
    ek: ek.toString("base64url"),
    iv: iv.toString("base64url"),
    ct: ct.toString("base64url"),
    tag: tag.toString("base64url"),
  }
  return `${ENVELOPE_PREFIX}${Buffer.from(JSON.stringify(envelope)).toString("base64url")}`
}

function decodeEnvelope(value: string): Envelope {
  if (!value.startsWith(ENVELOPE_PREFIX)) throw new Error("Unsupported envelope")
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.from(value.slice(ENVELOPE_PREFIX.length), "base64url").toString("utf8"))
  } catch {
    throw new Error("Invalid envelope")
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Invalid envelope")
  const envelope = parsed as Record<string, unknown>
  if (envelope.v !== ENVELOPE_VERSION || envelope.alg !== ENVELOPE_ALGORITHM) {
    throw new Error("Unsupported envelope version or algorithm")
  }
  for (const field of ["kid", "ek", "iv", "ct", "tag"] as const) {
    if (typeof envelope[field] !== "string") throw new Error("Invalid envelope")
  }
  const result = envelope as Envelope
  if (Buffer.from(result.iv, "base64url").length !== 12) throw new Error("Invalid envelope IV")
  if (Buffer.from(result.tag, "base64url").length !== 16) throw new Error("Invalid envelope tag")
  if (!Buffer.from(result.ek, "base64url").length) throw new Error("Invalid envelope key")
  return result
}

// Exposed for tests and for decrypting outside the plugin. It never writes plaintext.
export function decryptEnvelope(value: string, privateKey: string | Buffer): Buffer {
  const envelope = decodeEnvelope(value.trim())
  const key = createPrivateKey(privateKey)
  const publicKey = createPublicKey(key)
  if (publicKeyFingerprint(publicKey) !== envelope.kid) {
    throw new Error("Envelope key does not match the private key")
  }
  const aesKey = privateDecrypt(
    {
      key,
      padding: constants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: "sha256",
    },
    Buffer.from(envelope.ek, "base64url"),
  )
  const decipher = createDecipheriv("aes-256-gcm", aesKey, Buffer.from(envelope.iv, "base64url"), {
    authTagLength: 16,
  })
  decipher.setAAD(aad(envelope.kid))
  decipher.setAuthTag(Buffer.from(envelope.tag, "base64url"))
  return Buffer.concat([decipher.update(Buffer.from(envelope.ct, "base64url")), decipher.final()])
}
