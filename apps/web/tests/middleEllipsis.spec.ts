import { describe, expect, it } from 'vitest'
import { middleEllipsis } from '../src/utils/middleEllipsis'

describe('middleEllipsis', () => {
  it('returns short values unchanged (no ellipsis inserted)', () => {
    expect(middleEllipsis('short')).toBe('short')
    expect(middleEllipsis('')).toBe('')
  })

  it('returns values exactly at the threshold unchanged', () => {
    // default head=6 + tail=10 + ellipsis(1) = 17
    const exact = 'a'.repeat(17)
    expect(middleEllipsis(exact)).toBe(exact)
  })

  it('truncates one character past the threshold', () => {
    const value = 'a'.repeat(18)
    const expected = `${'a'.repeat(6)}…${'a'.repeat(10)}`
    expect(middleEllipsis(value)).toBe(expected)
  })

  it('produces the exact expected head…tail shape for a long value (default lengths)', () => {
    const value = 'synth-w4w7-9f2ab61c@example.com' // 32 chars
    const expectedHead = value.slice(0, 6) // 'synth-'
    const expectedTail = value.slice(-10) // '2c@example.com'.slice last 10
    expect(middleEllipsis(value)).toBe(`${expectedHead}…${expectedTail}`)
  })

  it('the visible result always ends with the last N characters of the input (the distinguishing suffix)', () => {
    const value = 'synth-w4w7-9f2ab61c@example.com'
    const result = middleEllipsis(value)
    expect(result.endsWith(value.slice(-10))).toBe(true)
  })

  it('the visible result always starts with the first N characters of the input', () => {
    const value = 'synth-w4w7-9f2ab61c@example.com'
    const result = middleEllipsis(value)
    expect(result.startsWith(value.slice(0, 6))).toBe(true)
  })

  it('two values sharing the same long prefix but different suffixes remain distinguishable', () => {
    // The differing characters (the '1's vs '2's) fall inside the last 10 characters —
    // the kept tail — so they must survive truncation.
    const a = middleEllipsis('synth-w4w7-1111111111')
    const b = middleEllipsis('synth-w4w7-2222222222')
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
