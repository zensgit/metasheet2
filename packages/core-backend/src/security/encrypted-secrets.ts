import crypto from 'node:crypto'

import { Logger } from '../core/logger'
// F4: reuse the existing production-runtime predicate instead of a second copy. auth-runtime-config
// imports nothing, so this cannot create a cycle. Note it treats ONLY the exact string 'production'
// as production ('prod' is non-production) — deliberately the same posture as the JWT_SECRET gate,
// so the two secrets can never disagree about which runtime they are in.
import { isProductionRuntime } from './auth-runtime-config'

const SECRET_PREFIX = 'enc:'
const ENCRYPTION_ALGORITHM = 'aes-256-gcm'
const KEY_ITERATIONS = 100_000
const KEY_LENGTH = 32
const IV_LENGTH = 16
const AUTH_TAG_LENGTH = 16

/**
 * Historic built-in fallbacks. They are PUBLIC (they live in this repository), so anything
 * encrypted with them is effectively plaintext. Exported so the same sentinels can be named in one
 * place.
 *
 * F3 correction: scripts/ops/validate-windows-runtime.ps1:142-168 lists these two values in
 * `$weakSecrets`, but it only ever emits WARN for them — `$failed` collects FAIL rows and the
 * script exits 1 only when `$failed.Count > 0` (:324). Its `<32` length check also explicitly
 * skips ENCRYPTION_SALT and its message names JWT_SECRET. So "the ops validator passed" does NOT
 * mean the material is safe; this module is the only place that actually refuses.
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
let rotationReadDefaultsWarned = false

// F4: twin of the (module-private) normalizeEnvString in ./auth-runtime-config. That one is not
// exported; if either changes, change both.
function normalizeEnvString(value: string | undefined | null): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
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

export interface ResolveEncryptionMaterialOptions {
  /**
   * F1 escape hatch, and the ONLY one: lets the production gate pass for a READ that is
   * deliberately decrypting data written under the built-in defaults — i.e. the
   * `process.env.ENCRYPTION_KEY = oldKey` step inside ConfigService.rotateKey(). Without it the
   * gate deadlocks the one migration it exists to force: a deployment stuck on the default key
   * could never rotate off it.
   *
   * Deliberately NOT reachable from configuration: it is an explicit code-level argument, never an
   * env var / header / request field, and nothing on a write path passes it. Whoever passes it has
   * already decided this specific call is a rotation read.
   */
  allowDefaultsForRotationRead?: boolean
}

/**
 * Single source of truth for the ENCRYPTION_KEY / ENCRYPTION_SALT pair.
 *
 * Production: missing or built-in-default material throws (fail-closed) — same posture as
 * resolveRuntimeJwtSecret() for JWT_SECRET. (The ops validator only WARNs about these sentinels;
 * see the DEFAULT_ENCRYPTION_* comment above.)
 * Non-production: unchanged behaviour (the built-in defaults stay usable) plus one warning per
 * process.
 *
 * Reads process.env on EVERY call and caches nothing but the warn latches, so
 * ConfigService.rotateKey()'s temporary `process.env.ENCRYPTION_KEY = …` swap keeps working.
 */
export function resolveEncryptionMaterial(
  env: EnvShape = process.env,
  options: ResolveEncryptionMaterialOptions = {},
): EncryptionMaterial {
  const issues = getEncryptionMaterialIssues(env)

  if (isProductionRuntime(env)) {
    if (issues.length > 0 && options.allowDefaultsForRotationRead === true) {
      if (!rotationReadDefaultsWarned) {
        rotationReadDefaultsWarned = true
        logger.warn(
          'Encryption key rotation read used default/unset material to decrypt existing rows; ' +
          'this bypass is read-only and the rotation target must still be non-default.',
          { issues },
        )
      }
      return {
        masterKey: env.ENCRYPTION_KEY || DEFAULT_ENCRYPTION_KEY,
        salt: env.ENCRYPTION_SALT || DEFAULT_ENCRYPTION_SALT,
      }
    }

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

export function deriveEncryptionKey(
  env: EnvShape = process.env,
  options: ResolveEncryptionMaterialOptions = {},
): Buffer {
  const material = resolveEncryptionMaterial(env, options)
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
