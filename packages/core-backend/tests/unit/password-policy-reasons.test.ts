import { describe, expect, it } from 'vitest'
import { validatePassword } from '../../src/auth/password-policy'

/**
 * `validatePassword` returns machine-readable `reasons` parallel to the English `errors`, so
 * clients can localise without parsing prose. The rules themselves are unchanged; this file
 * pins (a) one reason per failed rule, in rule order, (b) the English strings byte-for-byte,
 * and (c) the two inputs from the customer report: a password containing `123456` fails ONLY
 * the weak-pattern rule, and the same password without that fragment is valid.
 */
describe('validatePassword reason codes', () => {
  it('customer input with a 123456 fragment fails only weak_pattern', () => {
    const result = validatePassword('123456Asd')
    expect(result.valid).toBe(false)
    expect(result.reasons).toEqual(['weak_pattern'])
    expect(result.errors).toEqual(['Password contains a common weak pattern'])
  })

  it('the same shape without the weak fragment is valid', () => {
    const result = validatePassword('12345Asd')
    expect(result).toEqual({ valid: true, errors: [], reasons: [] })
  })

  it.each([
    ['too_short', 'Ab1xyzq', 'Password must be at least 8 characters long'],
    ['too_long', `Ab1${'x'.repeat(126)}`, 'Password must not exceed 128 characters'],
    ['no_lowercase', 'ABCDEFG1', 'Password must contain at least one lowercase letter'],
    ['no_uppercase', 'bcdefgh1', 'Password must contain at least one uppercase letter'],
    ['no_digit', 'Abcdefgh', 'Password must contain at least one number'],
    ['weak_pattern', 'XyAdmin9', 'Password contains a common weak pattern'],
  ] as const)('single-rule failure %s carries exactly that reason and its unchanged English text', (reason, password, message) => {
    const result = validatePassword(password)
    expect(result.valid).toBe(false)
    expect(result.reasons).toEqual([reason])
    expect(result.errors).toEqual([message])
  })

  it('length boundaries stay where they were (8 and 128 are accepted)', () => {
    expect(validatePassword('Abcdef12').valid).toBe(true)
    expect(validatePassword(`Ab1${'x'.repeat(125)}`)).toEqual({ valid: true, errors: [], reasons: [] })
  })

  it('reports every failed rule in rule order, index-aligned with errors', () => {
    const result = validatePassword('weak')
    expect(result.reasons).toEqual(['too_short', 'no_uppercase', 'no_digit'])
    expect(result.errors).toEqual([
      'Password must be at least 8 characters long',
      'Password must contain at least one uppercase letter',
      'Password must contain at least one number',
    ])
    expect(result.errors).toHaveLength(result.reasons.length)
  })
})
