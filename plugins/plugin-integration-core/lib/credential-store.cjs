'use strict'

// ---------------------------------------------------------------------------
// Credential store — plugin-integration-core
//
// Wraps external-system credentials (K3 WISE WebAPI passwords, SQL Server
// connection strings, PLM tokens, etc.) in AES-256-GCM envelope encryption.
//
// Runtime note (see SPIKE_NOTES.md): the documented `context.services.security`
// API is declared in types/plugin.ts but NOT wired at runtime
// (src/index.ts:1351-1356 only binds notification / automationRegistry /
// rbacProvisioning / platformAppInstances). We therefore keep this module
// self-contained and depend only on Node's built-in `crypto`.
//
// Key provisioning:
//   env INTEGRATION_ENCRYPTION_KEY = 64-hex-char (32-byte) or 44-b64-char key
//   production (NODE_ENV=production): key required — startup refuses otherwise
//   development / test: falls back to a deterministic dev key with a warning
//
// Ciphertext format (version-tagged so we can rotate in place later):
//   "v1:<iv_b64>:<tag_b64>:<data_b64>"
// ---------------------------------------------------------------------------

const crypto = require('node:crypto')

const ALGORITHM = 'aes-256-gcm'
const KEY_BYTES = 32
const IV_BYTES = 12
const VERSION_TAG = 'v1'
const ENV_KEY_NAME = 'INTEGRATION_ENCRYPTION_KEY'

// Dev-only deterministic fallback. 32 bytes. Do NOT ship to production.
const DEV_FALLBACK_KEY_HEX = '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff'

function isProduction() {
  return process.env.NODE_ENV === 'production'
}

function decodeKey(raw) {
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim()
  if (!trimmed) return null

  // Try hex (preferred — 64 chars for 32 bytes)
  if (/^[0-9a-fA-F]+$/.test(trimmed) && trimmed.length === KEY_BYTES * 2) {
    return Buffer.from(trimmed, 'hex')
  }

  // Try base64 (44 chars for 32 bytes with padding)
  try {
    const buf = Buffer.from(trimmed, 'base64')
    if (buf.length === KEY_BYTES) return buf
  } catch {
    // fall through
  }

  return null
}

function resolveKey({ logger } = {}) {
  const fromEnv = decodeKey(process.env[ENV_KEY_NAME])
  if (fromEnv) return { key: fromEnv, source: 'env' }

  if (isProduction()) {
    throw new Error(
      `[plugin-integration-core] ${ENV_KEY_NAME} is required in production. ` +
      `Provide a 32-byte hex (64 chars) or base64 (44 chars) key.`,
    )
  }

  const warnTarget = logger && typeof logger.warn === 'function' ? logger : console
  warnTarget.warn(
    `[plugin-integration-core] ${ENV_KEY_NAME} not set — using DEV fallback key. ` +
    `Set a real key before any non-development use.`,
  )
  return { key: Buffer.from(DEV_FALLBACK_KEY_HEX, 'hex'), source: 'dev-fallback' }
}

function encrypt(plaintext, key) {
  if (typeof plaintext !== 'string') {
    throw new TypeError('encrypt: plaintext must be a string')
  }
  const iv = crypto.randomBytes(IV_BYTES)
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv)
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return `${VERSION_TAG}:${iv.toString('base64')}:${tag.toString('base64')}:${encrypted.toString('base64')}`
}

function decrypt(ciphertext, key) {
  if (typeof ciphertext !== 'string') {
    throw new TypeError('decrypt: ciphertext must be a string')
  }
  const parts = ciphertext.split(':')
  if (parts.length !== 4 || parts[0] !== VERSION_TAG) {
    throw new Error('decrypt: invalid ciphertext format (expected v1:<iv>:<tag>:<data>)')
  }
  const [, ivB64, tagB64, dataB64] = parts
  const iv = Buffer.from(ivB64, 'base64')
  const tag = Buffer.from(tagB64, 'base64')
  const data = Buffer.from(dataB64, 'base64')
  if (iv.length !== IV_BYTES) throw new Error('decrypt: invalid IV length')
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv)
  decipher.setAuthTag(tag)
  const decrypted = Buffer.concat([decipher.update(data), decipher.final()])
  return decrypted.toString('utf8')
}

/**
 * Create a credential store bound to a concrete key. Exposed to other plugin
 * modules during activate() so they never need to handle raw keys directly.
 */
function createCredentialStore({ logger } = {}) {
  const { key, source } = resolveKey({ logger })

  return {
    source, // 'env' | 'dev-fallback' — for observability only
    encrypt(plaintext) {
      return encrypt(plaintext, key)
    },
    decrypt(ciphertext) {
      return decrypt(ciphertext, key)
    },
    /**
     * Produce a public-safe representation of a credential: never returns
     * plaintext, always returns the ciphertext + a short fingerprint for
     * correlation. Callers that need to hand a value back to a UI should use
     * this instead of `decrypt`.
     */
    fingerprint(ciphertext) {
      // HMAC-SHA256 truncated; key-scoped so fingerprints are stable per
      // deployment but not reversible outside it.
      const h = crypto.createHmac('sha256', key).update(ciphertext).digest('hex')
      return h.slice(0, 16)
    },
  }
}

module.exports = {
  createCredentialStore,
  // Exposed for tests only — do not import from other plugin modules.
  __internals: { encrypt, decrypt, decodeKey, DEV_FALLBACK_KEY_HEX, ENV_KEY_NAME },
}
