/**
 * W5-B: production fail-closed for the stored-secret encryption material.
 *
 * Contract under test:
 *  - NODE_ENV=production + (ENCRYPTION_KEY or ENCRYPTION_SALT missing / equal to the built-in
 *    default sentinel) => throw, with a VALUES-FREE message (variable names + reason only).
 *  - outside production => keep today's behaviour (built-in defaults usable) and warn ONCE per
 *    process, never per call.
 *  - the derived key must not drift: a ciphertext produced by the pre-change code under the
 *    built-in defaults still decrypts (golden vector below).
 *  - ConfigService.SecretManager shares the same gate and its rotateKey() env-swap keeps working,
 *    which requires the helper to re-read process.env on every call (no cached key material).
 *
 * Every literal secret in this file is an obvious fake.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const STRONG_KEY = 'w5b-fake-production-key-0123456789abcdef'
const STRONG_SALT = 'w5b-fake-production-salt-0123456789abcdef'
const OTHER_STRONG_KEY = 'w5b-fake-rotated-key-fedcba9876543210xyz'

const DEFAULT_KEY_SENTINEL = 'default-key-change-in-production'
const DEFAULT_SALT_SENTINEL = 'default-salt-change-in-production'

/**
 * Produced by the PRE-CHANGE implementation with ENCRYPTION_KEY/ENCRYPTION_SALT unset
 * (i.e. pbkdf2(default-key sentinel, default-salt sentinel, 100000, 32, sha256), fixed IV).
 * If key derivation drifts, this stops decrypting.
 */
const GOLDEN_DEFAULT_CIPHERTEXT =
  'enc:BwcHBwcHBwcHBwcHBwcHByekLs3F5HrBacK2w1DKXFkxOciqp++Z8jKt1fHK0cb06aY9xw=='
const GOLDEN_DEFAULT_PLAINTEXT = 'w5b-golden-plaintext'

const warnCalls: string[] = []

vi.mock('../../src/core/logger', () => {
  class Logger {
    constructor(_context?: string) {}
    debug(): void {}
    info(): void {}
    warn(message: string): void {
      warnCalls.push(message)
    }
    error(): void {}
  }
  return { Logger, createLogger: (ctx: string) => new Logger(ctx) }
})

type EncryptedSecretsModule = typeof import('../../src/security/encrypted-secrets')

const ENV_KEYS = ['NODE_ENV', 'ENCRYPTION_KEY', 'ENCRYPTION_SALT'] as const
let savedEnv: Record<string, string | undefined> = {}

function setEnv(values: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>>): void {
  for (const key of ENV_KEYS) {
    const value = values[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
}

async function loadEncryptedSecrets(): Promise<EncryptedSecretsModule> {
  return import('../../src/security/encrypted-secrets')
}

function encryptionWarnings(): string[] {
  return warnCalls.filter(message => message.includes('ENCRYPTION_KEY'))
}

function rotationReadWarnings(): string[] {
  return warnCalls.filter(message => message.includes('rotation read'))
}

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]))
  warnCalls.length = 0
  vi.resetModules()
})

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = savedEnv[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

describe('resolveEncryptionMaterial - production fail-closed', () => {
  it('throws when ENCRYPTION_KEY is not configured', async () => {
    const mod = await loadEncryptedSecrets()
    expect(() =>
      mod.resolveEncryptionMaterial({ NODE_ENV: 'production', ENCRYPTION_SALT: STRONG_SALT }),
    ).toThrow(/ENCRYPTION_KEY not configured/)
  })

  it('throws when ENCRYPTION_KEY is still the built-in default', async () => {
    const mod = await loadEncryptedSecrets()
    expect(() =>
      mod.resolveEncryptionMaterial({
        NODE_ENV: 'production',
        ENCRYPTION_KEY: DEFAULT_KEY_SENTINEL,
        ENCRYPTION_SALT: STRONG_SALT,
      }),
    ).toThrow(/ENCRYPTION_KEY uses the built-in default/)
  })

  it('throws when ENCRYPTION_SALT is still the built-in default', async () => {
    const mod = await loadEncryptedSecrets()
    expect(() =>
      mod.resolveEncryptionMaterial({
        NODE_ENV: 'production',
        ENCRYPTION_KEY: STRONG_KEY,
        ENCRYPTION_SALT: DEFAULT_SALT_SENTINEL,
      }),
    ).toThrow(/ENCRYPTION_SALT uses the built-in default/)
  })

  it('throws when ENCRYPTION_SALT is not configured', async () => {
    const mod = await loadEncryptedSecrets()
    expect(() =>
      mod.resolveEncryptionMaterial({ NODE_ENV: 'production', ENCRYPTION_KEY: STRONG_KEY }),
    ).toThrow(/ENCRYPTION_SALT not configured/)
  })

  it('keeps the production failure values-free', async () => {
    const mod = await loadEncryptedSecrets()
    let message = ''
    try {
      mod.resolveEncryptionMaterial({
        NODE_ENV: 'production',
        ENCRYPTION_KEY: DEFAULT_KEY_SENTINEL,
        ENCRYPTION_SALT: STRONG_SALT,
      })
    } catch (error) {
      message = error instanceof Error ? error.message : String(error)
    }
    expect(message).not.toBe('')
    expect(message).not.toContain(DEFAULT_KEY_SENTINEL)
    expect(message).not.toContain(DEFAULT_SALT_SENTINEL)
    expect(message).not.toContain(STRONG_SALT)
    expect(message).toContain('ENCRYPTION_KEY')
  })

  it('accepts configured production material and round-trips', async () => {
    const mod = await loadEncryptedSecrets()
    setEnv({ NODE_ENV: 'production', ENCRYPTION_KEY: STRONG_KEY, ENCRYPTION_SALT: STRONG_SALT })

    const material = mod.resolveEncryptionMaterial()
    expect(material.masterKey).toBe(STRONG_KEY)
    expect(material.salt).toBe(STRONG_SALT)

    const sealed = mod.encryptStoredSecretValue('w5b-plaintext')
    expect(mod.isEncryptedSecretValue(sealed)).toBe(true)
    expect(mod.decryptStoredSecretValue(sealed)).toBe('w5b-plaintext')
    expect(encryptionWarnings()).toHaveLength(0)
  })

  it('fails the write path (encrypt) in production when the key is missing', async () => {
    const mod = await loadEncryptedSecrets()
    setEnv({ NODE_ENV: 'production', ENCRYPTION_KEY: undefined, ENCRYPTION_SALT: STRONG_SALT })
    expect(() => mod.encryptStoredSecretValue('w5b-plaintext')).toThrow(/ENCRYPTION_KEY/)
    expect(() => mod.normalizeStoredSecretValue('w5b-plaintext')).toThrow(/ENCRYPTION_KEY/)
  })

  it('fails the read path (decrypt) in production when the key is missing', async () => {
    const mod = await loadEncryptedSecrets()
    setEnv({ NODE_ENV: 'production', ENCRYPTION_KEY: undefined, ENCRYPTION_SALT: STRONG_SALT })
    expect(() => mod.decryptStoredSecretValue(GOLDEN_DEFAULT_CIPHERTEXT)).toThrow(/ENCRYPTION_KEY/)
  })

  // F1: the rotation-read bypass exists only so a deployment stuck on the defaults can rotate off
  // them. It must stay read-only and explicit.
  it('allows a rotation READ on default material and warns once, values-free', async () => {
    const mod = await loadEncryptedSecrets()
    const prodDefaults = { NODE_ENV: 'production' }

    const first = mod.resolveEncryptionMaterial(prodDefaults, { allowDefaultsForRotationRead: true })
    expect(first.masterKey).toBe(DEFAULT_KEY_SENTINEL)
    expect(first.salt).toBe(DEFAULT_SALT_SENTINEL)
    mod.resolveEncryptionMaterial(prodDefaults, { allowDefaultsForRotationRead: true })

    expect(rotationReadWarnings()).toHaveLength(1)
    expect(rotationReadWarnings()[0]).not.toContain(DEFAULT_KEY_SENTINEL)
    expect(rotationReadWarnings()[0]).not.toContain(DEFAULT_SALT_SENTINEL)
  })

  it('keeps the bypass off the write path: it is opt-in and nothing on a write passes it', async () => {
    const mod = await loadEncryptedSecrets()
    setEnv({ NODE_ENV: 'production', ENCRYPTION_KEY: undefined, ENCRYPTION_SALT: undefined })
    // same process, same env as the allowed rotation read above — but the write helpers never
    // forward the option, so they still fail closed.
    expect(() => mod.encryptStoredSecretValue('w5b-plaintext')).toThrow(/ENCRYPTION_KEY/)
    expect(() => mod.resolveEncryptionMaterial()).toThrow(/ENCRYPTION_KEY/)
  })
})

describe('resolveEncryptionMaterial - non-production stays permissive', () => {
  it('warns exactly once per process and still round-trips on defaults', async () => {
    const mod = await loadEncryptedSecrets()
    setEnv({ NODE_ENV: 'test', ENCRYPTION_KEY: undefined, ENCRYPTION_SALT: undefined })

    const sealed = mod.encryptStoredSecretValue('w5b-dev-plaintext')
    expect(mod.decryptStoredSecretValue(sealed)).toBe('w5b-dev-plaintext')
    mod.resolveEncryptionMaterial()
    mod.resolveEncryptionMaterial()
    mod.encryptStoredSecretValue('again')

    expect(encryptionWarnings()).toHaveLength(1)
    expect(encryptionWarnings()[0]).not.toContain(DEFAULT_KEY_SENTINEL)
  })

  it('does not drift the derived key: a pre-change default ciphertext still decrypts', async () => {
    const mod = await loadEncryptedSecrets()
    setEnv({ NODE_ENV: 'test', ENCRYPTION_KEY: undefined, ENCRYPTION_SALT: undefined })
    expect(mod.decryptStoredSecretValue(GOLDEN_DEFAULT_CIPHERTEXT)).toBe(GOLDEN_DEFAULT_PLAINTEXT)
  })

  it('does not trim the value used for derivation (trim is validation-only)', async () => {
    const mod = await loadEncryptedSecrets()
    setEnv({ NODE_ENV: 'test', ENCRYPTION_KEY: `  ${STRONG_KEY}  `, ENCRYPTION_SALT: STRONG_SALT })
    expect(mod.resolveEncryptionMaterial().masterKey).toBe(`  ${STRONG_KEY}  `)
  })

  it('does not warn when non-production material is explicitly configured', async () => {
    const mod = await loadEncryptedSecrets()
    setEnv({ NODE_ENV: 'test', ENCRYPTION_KEY: STRONG_KEY, ENCRYPTION_SALT: STRONG_SALT })
    mod.encryptStoredSecretValue('w5b-plaintext')
    expect(encryptionWarnings()).toHaveLength(0)
  })
})

describe('ConfigService SecretManager shares the gate', () => {
  async function loadConfigService() {
    vi.doMock('../../src/db/db', () => ({ db: undefined }))
    return import('../../src/services/ConfigService')
  }

  it('refuses to encrypt in production without ENCRYPTION_KEY, unwrapped', async () => {
    const { SecretManager } = await loadConfigService()
    setEnv({ NODE_ENV: 'production', ENCRYPTION_KEY: undefined, ENCRYPTION_SALT: STRONG_SALT })
    const manager = new SecretManager()
    await expect(manager.encrypt('w5b-plaintext')).rejects.toThrow(/ENCRYPTION_KEY/)
  })

  it('refuses to encrypt in production on the built-in default salt', async () => {
    const { SecretManager } = await loadConfigService()
    setEnv({ NODE_ENV: 'production', ENCRYPTION_KEY: STRONG_KEY, ENCRYPTION_SALT: undefined })
    const manager = new SecretManager()
    await expect(manager.encrypt('w5b-plaintext')).rejects.toThrow(/ENCRYPTION_SALT/)
  })

  it('still round-trips outside production on defaults', async () => {
    const { SecretManager } = await loadConfigService()
    setEnv({ NODE_ENV: 'test', ENCRYPTION_KEY: undefined, ENCRYPTION_SALT: undefined })
    const manager = new SecretManager()
    const sealed = await manager.encrypt('w5b-dev-plaintext')
    expect(await manager.decrypt(sealed)).toBe('w5b-dev-plaintext')
  })

  it('re-reads ENCRYPTION_KEY per call so rotateKey can swap old/new', async () => {
    const { SecretManager } = await loadConfigService()
    setEnv({ NODE_ENV: 'production', ENCRYPTION_KEY: STRONG_KEY, ENCRYPTION_SALT: STRONG_SALT })
    const manager = new SecretManager()

    const underOldKey = await manager.encrypt('w5b-rotating')
    expect(await manager.decrypt(underOldKey)).toBe('w5b-rotating')

    // rotateKey() flips process.env.ENCRYPTION_KEY between old and new around each row.
    process.env.ENCRYPTION_KEY = OTHER_STRONG_KEY
    await expect(manager.decrypt(underOldKey)).rejects.toThrow()
    const underNewKey = await manager.encrypt('w5b-rotating')
    expect(await manager.decrypt(underNewKey)).toBe('w5b-rotating')

    process.env.ENCRYPTION_KEY = STRONG_KEY
    expect(await manager.decrypt(underOldKey)).toBe('w5b-rotating')
  })

  it('rotateKey re-encrypts stored rows from the old key to the new key', async () => {
    setEnv({ NODE_ENV: 'production', ENCRYPTION_KEY: STRONG_KEY, ENCRYPTION_SALT: STRONG_SALT })

    const { SecretManager: Probe } = await import('../../src/services/ConfigService')
    process.env.ENCRYPTION_KEY = STRONG_KEY
    const legacyCipher = await new Probe().encrypt('w5b-rotating-row')

    vi.resetModules()
    const updates: Array<{ id: string; value: string }> = []
    vi.doMock('../../src/db/db', () => ({
      db: {
        selectFrom: () => ({
          select: () => ({
            where: () => ({
              execute: async () => [{ id: 'cfg-1', key: 'a.b', value: legacyCipher }],
            }),
          }),
        }),
        updateTable: () => ({
          set: (patch: { value: string }) => ({
            where: (_col: string, _op: string, id: string) => ({
              execute: async () => {
                updates.push({ id, value: patch.value })
              },
            }),
          }),
        }),
      },
    }))

    const { SecretManager } = await import('../../src/services/ConfigService')
    const manager = new SecretManager()
    await manager.rotateKey(STRONG_KEY, OTHER_STRONG_KEY)

    expect(updates).toHaveLength(1)
    // Pre-existing ConfigService behaviour (ConfigService.ts, end of rotateKey): the process is
    // left on the new key. Asserted to pin it, NOT introduced as a contract by this PR.
    expect(process.env.ENCRYPTION_KEY).toBe(OTHER_STRONG_KEY)
    expect(await manager.decrypt(updates[0].value)).toBe('w5b-rotating-row')
  })

  /** Minimal kysely-shaped stub: one encrypted row in, captured UPDATEs out. */
  function mockRowsDb(value: string, updates: Array<{ id: string; value: string }>) {
    return {
      db: {
        selectFrom: () => ({
          select: () => ({
            where: () => ({ execute: async () => [{ id: 'cfg-1', key: 'a.b', value }] }),
          }),
        }),
        updateTable: () => ({
          set: (patch: { value: string }) => ({
            where: (_col: string, _op: string, id: string) => ({
              execute: async () => {
                updates.push({ id, value: patch.value })
              },
            }),
          }),
        }),
      },
    }
  }

  // F1 regression: before the rotation-read bypass this deadlocked — the gate refused the
  // decrypt-with-the-old-default-key step, so a deployment on the built-in defaults (the ONLY
  // deployment that needs to migrate) could never rotate off them.
  it('rotates OFF the built-in defaults in production (default key+salt -> strong key+salt)', async () => {
    // Row written by a process running on the built-in defaults.
    setEnv({ NODE_ENV: 'test', ENCRYPTION_KEY: undefined, ENCRYPTION_SALT: undefined })
    const { SecretManager: Probe } = await import('../../src/services/ConfigService')
    const legacyCipher = await new Probe().encrypt('w5b-legacy-default-row')

    vi.resetModules()
    const updates: Array<{ id: string; value: string }> = []
    vi.doMock('../../src/db/db', () => mockRowsDb(legacyCipher, updates))

    const { SecretManager } = await import('../../src/services/ConfigService')
    setEnv({ NODE_ENV: 'production', ENCRYPTION_KEY: undefined, ENCRYPTION_SALT: undefined })
    const manager = new SecretManager()

    await manager.rotateKey(DEFAULT_KEY_SENTINEL, STRONG_KEY, { newSalt: STRONG_SALT })

    expect(updates).toHaveLength(1)
    expect(process.env.ENCRYPTION_KEY).toBe(STRONG_KEY)
    expect(process.env.ENCRYPTION_SALT).toBe(STRONG_SALT)
    // Readable under the NEW material with no bypass at all.
    expect(await manager.decrypt(updates[0].value)).toBe('w5b-legacy-default-row')
    expect(rotationReadWarnings()).toHaveLength(1)
  })

  it('refuses a rotation TARGET that is the built-in default, and restores env', async () => {
    setEnv({ NODE_ENV: 'production', ENCRYPTION_KEY: STRONG_KEY, ENCRYPTION_SALT: STRONG_SALT })
    const { SecretManager: Probe } = await import('../../src/services/ConfigService')
    const cipher = await new Probe().encrypt('w5b-rotating-row')

    vi.resetModules()
    const updates: Array<{ id: string; value: string }> = []
    vi.doMock('../../src/db/db', () => mockRowsDb(cipher, updates))

    const { SecretManager } = await import('../../src/services/ConfigService')
    setEnv({ NODE_ENV: 'production', ENCRYPTION_KEY: STRONG_KEY, ENCRYPTION_SALT: STRONG_SALT })
    const manager = new SecretManager()

    await expect(manager.rotateKey(STRONG_KEY, DEFAULT_KEY_SENTINEL)).rejects.toThrow(
      /ENCRYPTION_KEY uses the built-in default/,
    )
    expect(updates).toHaveLength(0)
    expect(process.env.ENCRYPTION_KEY).toBe(STRONG_KEY)
  })

  it('refuses a rotation TARGET salt that is the built-in default', async () => {
    setEnv({ NODE_ENV: 'production', ENCRYPTION_KEY: STRONG_KEY, ENCRYPTION_SALT: STRONG_SALT })
    const { SecretManager: Probe } = await import('../../src/services/ConfigService')
    const cipher = await new Probe().encrypt('w5b-rotating-row')

    vi.resetModules()
    const updates: Array<{ id: string; value: string }> = []
    vi.doMock('../../src/db/db', () => mockRowsDb(cipher, updates))

    const { SecretManager } = await import('../../src/services/ConfigService')
    setEnv({ NODE_ENV: 'production', ENCRYPTION_KEY: STRONG_KEY, ENCRYPTION_SALT: STRONG_SALT })
    const manager = new SecretManager()

    await expect(
      manager.rotateKey(STRONG_KEY, OTHER_STRONG_KEY, { newSalt: DEFAULT_SALT_SENTINEL }),
    ).rejects.toThrow(/ENCRYPTION_SALT uses the built-in default/)
    expect(updates).toHaveLength(0)
    expect(process.env.ENCRYPTION_SALT).toBe(STRONG_SALT)
  })
})
