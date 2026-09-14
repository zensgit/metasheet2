import crypto from 'node:crypto'

import { Logger } from '../core/logger'

const SECRET_PREFIX = 'enc:'
const ENCRYPTION_ALGORITHM = 'aes-256-gcm'
const KEY_ITERATIONS = 100_000
const KEY_LENGTH = 32
const IV_LENGTH = 16
const AUTH_TAG_LENGTH = 16

/**
 * Historic built-in fallbacks. They are PUBLIC (they live in this repository), so anything
 * encrypted with them is effectively plaintext. Kept exported so the runtime validator and the
 * operational checks (scripts/ops/validate-windows-runtime.ps1) can name the same sentinels.
 */
export const DEFAULT_ENCRYPTION_KEY = 'default-key-change-in-production'
export const DEFAULT_ENCRYPTION_SALT = 'default-salt-change-in-production'

export const INSECURE_ENCRYPTION_MATERIAL_WARNING =
  'Insecure encryption material: ENCRYPTION_KEY / ENCRYPTION_SALT are unset or still the built-in ' +
  'defaults, so stored secrets are NOT confidential. Tolerated outside production only; production ' +
  'refuses to start encrypting or decrypting until both are configured.'

type EnvShape = Record<string, string | undefined>

export interface EncryptionMaterial {
  /** Raw master key passed to pbkdf2 — byte-identical to what the process would have used before. */
  masterKey: string
  /** Raw salt passed to pbkdf2. */
  salt: string
}

/** Thrown when production is missing usable encryption material. Never carries a secret value. */
export class EncryptionMaterialError extends Error {
  readonly issues: string[]

  constructor(issues: string[]) {
    super(`Invalid encryption material for production: ${issues.join('; ')}`)
    this.name = 'EncryptionMaterialError'
    this.issues = issues
  }
}

const logger = new Logger('EncryptedSecrets')

/** Process-wide latches: the advisory must not fire once per encrypted field. */
let insecureMaterialWarned = false
let shortProductionKeyWarned = false

function normalizeEnvString(value: string | undefined | null): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

export function isProductionRuntime(env: EnvShape = process.env): boolean {
  return normalizeEnvString(env.NODE_ENV) === 'production'
}

/**
 * Values-free description of what is wrong with the configured material. Empty array = usable.
 *
 * NOTE the asymmetry, and it is deliberate: validation looks at the TRIMMED value, but derivation
 * (see resolveEncryptionMaterial) uses the RAW value. Trimming the derivation input would change
 * pbkdf2's output for any deployment whose key has stray whitespace and make every already-stored
 * secret undecryptable.
 */
export function getEncryptionMaterialIssues(env: EnvShape = process.env): string[] {
  const issues: string[] = []
  const key = normalizeEnvString(env.ENCRYPTION_KEY)
  const salt = normalizeEnvString(env.ENCRYPTION_SALT)

  if (!key) {
    issues.push('ENCRYPTION_KEY not configured / not set')
  } else if (key === DEFAULT_ENCRYPTION_KEY) {
    issues.push('ENCRYPTION_KEY uses the built-in default placeholder value')
  }

  if (!salt) {
    issues.push('ENCRYPTION_SALT not configured / not set')
  } else if (salt === DEFAULT_ENCRYPTION_SALT) {
    issues.push('ENCRYPTION_SALT uses the built-in default placeholder value')
  }

  return issues
}

/**
 * Single source of truth for the ENCRYPTION_KEY / ENCRYPTION_SALT pair.
 *
 * Production: missing or built-in-default material throws (fail-closed) — same posture as
 * resolveRuntimeJwtSecret() for JWT_SECRET, and the same sentinels that
 * scripts/ops/validate-windows-runtime.ps1 already refuses.
 * Non-production: unchanged behaviour (the built-in defaults stay usable) plus one warning per
 * process.
 *
 * Reads process.env on EVERY call and caches nothing but the warn latches, so
 * ConfigService.rotateKey()'s temporary `process.env.ENCRYPTION_KEY = …` swap keeps working.
 */
export function resolveEncryptionMaterial(env: EnvShape = process.env): EncryptionMaterial {
  const issues = getEncryptionMaterialIssues(env)

  if (isProductionRuntime(env)) {
    if (issues.length > 0) {
      throw new EncryptionMaterialError(issues)
    }

    const configuredKey = env.ENCRYPTION_KEY as string
    if (!shortProductionKeyWarned && configuredKey.trim().length < 32) {
      shortProductionKeyWarned = true
      // Advisory only: length is enforced by the ops validator, not here, so an existing
      // deployment with a short-but-non-default key is not bricked by this change.
      logger.warn(
        'ENCRYPTION_KEY is shorter than the recommended 32 characters; rotate to a stronger value.',
      )
    }

    return { masterKey: configuredKey, salt: env.ENCRYPTION_SALT as string }
  }

  if (issues.length > 0 && !insecureMaterialWarned) {
    insecureMaterialWarned = true
    logger.warn(INSECURE_ENCRYPTION_MATERIAL_WARNING, { issues })
  }

  // `|| DEFAULT` (not the normalized value) reproduces the pre-change fallback byte for byte.
  return {
    masterKey: env.ENCRYPTION_KEY || DEFAULT_ENCRYPTION_KEY,
    salt: env.ENCRYPTION_SALT || DEFAULT_ENCRYPTION_SALT,
  }
}

/**
 * Startup-style assertion: fails in production when the material is unusable, no-op otherwise.
 * Exported so a future centralized env validation step can fail fast instead of failing on the
 * first credential operation. (core-backend has no such central step today.)
 */
export function assertProductionEncryptionMaterial(env: EnvShape = process.env): void {
  resolveEncryptionMaterial(env)
}

function getEncryptionSalt(material: EncryptionMaterial): Buffer {
  return Buffer.from(material.salt)
}

export function deriveEncryptionKey(env: EnvShape = process.env): Buffer {
  const material = resolveEncryptionMaterial(env)
  return crypto.pbkdf2Sync(
    material.masterKey,
    getEncryptionSalt(material),
    KEY_ITERATIONS,
    KEY_LENGTH,
    'sha256',
  )
}

export function isEncryptedSecretValue(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith(SECRET_PREFIX)
}

function encryptRawSecretValue(plaintext: string): string {
  const iv = crypto.randomBytes(IV_LENGTH)
  const cipher = crypto.createCipheriv(ENCRYPTION_ALGORITHM, deriveEncryptionKey(), iv)

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

  const decipher = crypto.createDecipheriv(ENCRYPTION_ALGORITHM, deriveEncryptionKey(), iv)
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
