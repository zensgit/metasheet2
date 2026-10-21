import { describe, expect, it } from 'vitest'
import { middleEllipsis } from '../src/utils/middleEllipsis'

/**
 * Generic head+tail truncation contract only. This function is NOT used directly for the
 * app header's email-shaped account identity any more — a fixed-length tail measured from
 * the end of the whole string keeps only the domain for a long-domain email (see the
 * regression this caused, fixed in accountIdentityDisplay.ts / P1 of GATE-5047). The
 * email-account-identity behavior (including the real 43-char/20-char-domain staging
 * shape) is covered in tests/accountIdentityDisplay.spec.ts instead. These tests use plain
 * non-email fixtures so nothing here implies production relevance for emails.
 */
describe('middleEllipsis', () => {
  it('returns short values unchanged (no ellipsis inserted)', () => {
    expect(middleEllipsis('short')).toBe('short')
    expect(middleEllipsis('')).toBe('')
  })

  it('returns values exactly at the threshold unchanged', () => {
    // default head=6 + tail=20 + ellipsis(1) = 27
    const exact = 'a'.repeat(27)
    expect(middleEllipsis(exact)).toBe(exact)
  })

  it('truncates one character past the threshold', () => {
    const value = 'a'.repeat(28)
    const expected = `${'a'.repeat(6)}…${'a'.repeat(20)}`
    expect(middleEllipsis(value)).toBe(expected)
  })

  it('produces the exact expected head…tail shape for a long generic value (default lengths)', () => {
    const value = 'HEAD01-0123456789-0123456789-TAIL01' // 36 chars, no '@'
    const expectedHead = value.slice(0, 6)
    const expectedTail = value.slice(-20)
    expect(middleEllipsis(value)).toBe(`${expectedHead}…${expectedTail}`)
  })

  it('the visible result always ends with the last N characters of the input', () => {
    const value = 'HEAD01-0123456789-0123456789-TAIL01'
    const result = middleEllipsis(value)
    expect(result.endsWith(value.slice(-20))).toBe(true)
  })

  it('the visible result always starts with the first N characters of the input', () => {
    const value = 'HEAD01-0123456789-0123456789-TAIL01'
    const result = middleEllipsis(value)
    expect(result.startsWith(value.slice(0, 6))).toBe(true)
  })

  it('two long generic values sharing the same head and a same-length differing tail remain distinguishable', () => {
    const a = middleEllipsis('shared-head-0000000000000000000001')
    const b = middleEllipsis('shared-head-0000000000000000000002')
    expect(a).not.toBe(b)
  })

  it('respects custom headLength/tailLength/maxLength', () => {
    expect(middleEllipsis('abcdefghijklmnop', { headLength: 2, tailLength: 2, maxLength: 5 }))
      .toBe('ab…op')
    expect(middleEllipsis('abcd', { headLength: 2, tailLength: 2, maxLength: 5 })).toBe('abcd') // under threshold
  })

  it('handles a zero tailLength (head-only truncation, no suffix kept)', () => {
    expect(middleEllipsis('abcdefghijklmnop', { headLength: 3, tailLength: 0, maxLength: 5 })).toBe('abc…')
  })

  it('returns an empty string for null/undefined input', () => {
    expect(middleEllipsis(null)).toBe('')
    expect(middleEllipsis(undefined)).toBe('')
  })
})
