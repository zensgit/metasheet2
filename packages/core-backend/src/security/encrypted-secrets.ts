import crypto from 'node:crypto'

const SECRET_PREFIX = 'enc:'
const ENCRYPTION_ALGORITHM = 'aes-256-gcm'
const KEY_ITERATIONS = 100_000
const KEY_LENGTH = 32
const IV_LENGTH = 16
const AUTH_TAG_LENGTH = 16

function getEncryptionSalt(): Buffer {
  return Buffer.from(process.env.ENCRYPTION_SALT || 'default-salt-change-in-production')
}

function getEncryptionKey(): Buffer {
  const masterKey = process.env.ENCRYPTION_KEY || 'default-key-change-in-production'
  return crypto.pbkdf2Sync(masterKey, getEncryptionSalt(), KEY_ITERATIONS, KEY_LENGTH, 'sha256')
}

export function isEncryptedSecretValue(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith(SECRET_PREFIX)
}

function encryptRawSecretValue(plaintext: string): string {
  const iv = crypto.randomBytes(IV_LENGTH)
  const cipher = crypto.createCipheriv(ENCRYPTION_ALGORITHM, getEncryptionKey(), iv)

  const ciphertext = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ])
  const authTag = cipher.getAuthTag()

  return Buffer.concat([iv, authTag, ciphertext]).toString('base64')
}

function decryptRawSecretValue(ciphertext: string): string {
  const payload = Buffer.from(ciphertext, 'base64')
  const iv = payload.subarray(0, IV_LENGTH)
  const authTag = payload.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH)
  const encrypted = payload.subarray(IV_LENGTH + AUTH_TAG_LENGTH)

  const decipher = crypto.createDecipheriv(ENCRYPTION_ALGORITHM, getEncryptionKey(), iv)
  decipher.setAuthTag(authTag)

  return Buffer.concat([
    decipher.update(encrypted),
    decipher.final(),
  ]).toString('utf8')
}

export function encryptStoredSecretValue(plaintext: string): string {
  return `${SECRET_PREFIX}${encryptRawSecretValue(plaintext)}`
}

export function decryptStoredSecretValue(value: string): string {
  if (!isEncryptedSecretValue(value)) return value
  return decryptRawSecretValue(value.slice(SECRET_PREFIX.length))
}

export function normalizeStoredSecretValue(value: string): string {
  const normalized = typeof value === 'string' ? value.trim() : ''
  if (!normalized) return ''
  if (isEncryptedSecretValue(normalized)) return normalized
  return encryptStoredSecretValue(normalized)
}
