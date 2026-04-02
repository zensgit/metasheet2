import { describe, expect, it } from 'vitest'
import {
  DEV_FALLBACK_JWT_SECRET,
  getBcryptSaltRounds,
  getJwtSecretValidationIssues,
  getProductionAuthSecurityIssues,
  resolveRuntimeJwtSecret,
} from '../../src/security/auth-runtime-config'

describe('auth-runtime-config', () => {
  it('falls back to the dev secret outside production', () => {
    expect(resolveRuntimeJwtSecret(undefined, { NODE_ENV: 'test' })).toBe(DEV_FALLBACK_JWT_SECRET)
  })

  it('rejects weak production JWT secrets', () => {
    expect(() => resolveRuntimeJwtSecret('test', { NODE_ENV: 'production' })).toThrow(/Invalid JWT_SECRET/)
    expect(getJwtSecretValidationIssues('short-secret')).toContain(
      'JWT_SECRET is too short (minimum 32 characters required)',
    )
  })

  it('accepts strong production JWT secrets', () => {
    const secret = 'prod-secret-abcdefghijklmnopqrstuvwxyz123456'
    expect(resolveRuntimeJwtSecret(secret, { NODE_ENV: 'production' })).toBe(secret)
  })

  it('uses stricter bcrypt defaults in production', () => {
    expect(getBcryptSaltRounds({ NODE_ENV: 'test' })).toBe(10)
    expect(getBcryptSaltRounds({ NODE_ENV: 'production' })).toBe(12)
    expect(getBcryptSaltRounds({ NODE_ENV: 'production', BCRYPT_SALT_ROUNDS: '14' })).toBe(14)
  })

  it('reports production auth security issues for weak env values', () => {
    expect(getProductionAuthSecurityIssues({
      NODE_ENV: 'production',
      JWT_SECRET: 'prod-secret-abcdefghijklmnopqrstuvwxyz123456',
      BCRYPT_SALT_ROUNDS: '10',
      RBAC_TOKEN_TRUST: 'true',
    })).toEqual([
      'BCRYPT_SALT_ROUNDS too low for production (10, required: >=12)',
      'RBAC_TOKEN_TRUST is ignored in production and must remain disabled',
    ])
  })
})
