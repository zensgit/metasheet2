/**
 * W5-B F2: plugin-attendance carries its OWN copy of the stored-secret crypto
 * (plugins/plugin-attendance/index.cjs `getIntegrationSecretKey`) — same `enc:` prefix, same
 * aes-256-gcm, same pbkdf2 params, same two built-in default fallbacks — and it is what encrypts
 * the DingTalk appSecret into the DB (`normalizeIntegrationConfigForStorage`). It cannot import the
 * TS helper (CJS), so it re-states the production gate; this spec holds that third pipeline to the
 * same posture as packages/core-backend/src/security/encrypted-secrets.ts.
 *
 * The symbols exercised here are the REAL ones the write/read paths call, exported through
 * `__attendanceIntegrationSecretForTests`.
 *
 * Every literal secret below is an obvious fake.
 */
import crypto from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

// eslint-disable-next-line @typescript-eslint/no-var-requires
const attendancePlugin = require('../../../../plugins/plugin-attendance/index.cjs')

const {
  getIntegrationSecretKey,
  encryptIntegrationSecretValue,
  decryptIntegrationSecretValue,
} = attendancePlugin.__attendanceIntegrationSecretForTests

const STRONG_KEY = 'w5b-fake-attendance-key-0123456789abcdef'
const STRONG_SALT = 'w5b-fake-attendance-salt-0123456789abcde'
const DEFAULT_KEY_SENTINEL = 'default-key-change-in-production'
const DEFAULT_SALT_SENTINEL = 'default-salt-change-in-production'

const ENV_KEYS = ['NODE_ENV', 'ENCRYPTION_KEY', 'ENCRYPTION_SALT'] as const
let savedEnv: Record<string, string | undefined> = {}

function setEnv(values: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>>): void {
  for (const key of ENV_KEYS) {
    const value = values[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
}

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]))
})

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = savedEnv[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

describe('plugin-attendance integration secret material gate', () => {
  it('refuses unset material in production', () => {
    setEnv({ NODE_ENV: 'production', ENCRYPTION_KEY: undefined, ENCRYPTION_SALT: undefined })
    expect(() => getIntegrationSecretKey()).toThrow(/ENCRYPTION_KEY not configured/)
  })

  it('refuses the built-in default key in production', () => {
    setEnv({
      NODE_ENV: 'production',
      ENCRYPTION_KEY: DEFAULT_KEY_SENTINEL,
      ENCRYPTION_SALT: STRONG_SALT,
    })
    expect(() => getIntegrationSecretKey()).toThrow(/ENCRYPTION_KEY uses the built-in default/)
  })

  it('refuses the built-in default salt in production', () => {
    setEnv({
      NODE_ENV: 'production',
      ENCRYPTION_KEY: STRONG_KEY,
      ENCRYPTION_SALT: DEFAULT_SALT_SENTINEL,
    })
    expect(() => getIntegrationSecretKey()).toThrow(/ENCRYPTION_SALT uses the built-in default/)
  })

  it('keeps the production failure values-free', () => {
    setEnv({
      NODE_ENV: 'production',
      ENCRYPTION_KEY: DEFAULT_KEY_SENTINEL,
      ENCRYPTION_SALT: STRONG_SALT,
    })
    let message = ''
    try {
      getIntegrationSecretKey()
    } catch (error) {
      message = error instanceof Error ? error.message : String(error)
    }
    expect(message).not.toBe('')
    expect(message).not.toContain(DEFAULT_KEY_SENTINEL)
    expect(message).not.toContain(DEFAULT_SALT_SENTINEL)
    expect(message).not.toContain(STRONG_SALT)
  })

  it('blocks the appSecret WRITE path in production, not just the key helper', () => {
    setEnv({ NODE_ENV: 'production', ENCRYPTION_KEY: undefined, ENCRYPTION_SALT: undefined })
    expect(() => encryptIntegrationSecretValue('w5b-fake-app-secret')).toThrow(/ENCRYPTION_KEY/)
  })

  it('accepts configured production material and round-trips', () => {
    setEnv({ NODE_ENV: 'production', ENCRYPTION_KEY: STRONG_KEY, ENCRYPTION_SALT: STRONG_SALT })
    const sealed = encryptIntegrationSecretValue('w5b-fake-app-secret')
    expect(sealed.startsWith('enc:')).toBe(true)
    expect(decryptIntegrationSecretValue(sealed)).toBe('w5b-fake-app-secret')
  })

  it('leaves non-production on the built-in defaults, byte-identical to before', () => {
    setEnv({ NODE_ENV: 'test', ENCRYPTION_KEY: undefined, ENCRYPTION_SALT: undefined })
    const expected = crypto.pbkdf2Sync(
      DEFAULT_KEY_SENTINEL,
      Buffer.from(DEFAULT_SALT_SENTINEL),
      100000,
      32,
      'sha256',
    )
    expect(Buffer.compare(getIntegrationSecretKey(), expected)).toBe(0)
    const sealed = encryptIntegrationSecretValue('w5b-dev-app-secret')
    expect(decryptIntegrationSecretValue(sealed)).toBe('w5b-dev-app-secret')
  })

  it('does not trim the value used for derivation (trim is validation-only)', () => {
    setEnv({ NODE_ENV: 'test', ENCRYPTION_KEY: `  ${STRONG_KEY}  `, ENCRYPTION_SALT: STRONG_SALT })
    const padded = getIntegrationSecretKey()
    setEnv({ NODE_ENV: 'test', ENCRYPTION_KEY: STRONG_KEY, ENCRYPTION_SALT: STRONG_SALT })
    expect(Buffer.compare(padded, getIntegrationSecretKey())).not.toBe(0)
  })
})
