import { describe, expect, it } from 'vitest'
import {
  inferLoginAliasKind,
  normalizeLoginIdentifier,
} from '../../src/auth/login-identifier'

describe('normalizeLoginIdentifier (T2 locked)', () => {
  it('lowercases full email (NFKC + trim)', () => {
    expect(normalizeLoginIdentifier('  Foo.Bar@Example.COM ')).toBe('foo.bar@example.com')
    expect(inferLoginAliasKind('Foo.Bar@Example.COM')).toBe('email')
  })

  it('normalizes mainland mobile to +86…', () => {
    expect(normalizeLoginIdentifier('139-0000-1234')).toBe('+8613900001234')
    expect(normalizeLoginIdentifier('13900001234')).toBe('+8613900001234')
    expect(inferLoginAliasKind('13900001234')).toBe('mobile')
  })

  it('keeps explicit +country mobile digits', () => {
    expect(normalizeLoginIdentifier('+1 (415) 555-2671')).toBe('+14155552671')
  })

  it('lowercases username (case-insensitive login namespace)', () => {
    expect(normalizeLoginIdentifier('LiQing')).toBe('liqing')
    expect(inferLoginAliasKind('LiQing')).toBe('username')
  })

  it('returns null for empty / non-string', () => {
    expect(normalizeLoginIdentifier('')).toBeNull()
    expect(normalizeLoginIdentifier('   ')).toBeNull()
    expect(normalizeLoginIdentifier(null)).toBeNull()
    expect(normalizeLoginIdentifier(42)).toBeNull()
  })

  it('collapses email-local-part vs username into same normalized space', () => {
    // Same global namespace: these MUST share one key if both claim "admin"
    // email form vs bare username differ when @ present
    expect(normalizeLoginIdentifier('admin@corp.com')).toBe('admin@corp.com')
    expect(normalizeLoginIdentifier('Admin')).toBe('admin')
  })
})
