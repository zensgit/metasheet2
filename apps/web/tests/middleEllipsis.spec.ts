import { describe, expect, it } from 'vitest'
import { middleEllipsis } from '../src/utils/middleEllipsis'

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

  it('produces the exact expected head…tail shape for a long value (default lengths)', () => {
    const value = 'synth-w4w7-9f2ab61c@example.com' // 31 chars
    const expectedHead = value.slice(0, 6) // 'synth-'
    const expectedTail = value.slice(-20) // '9f2ab61c@example.com'
    expect(middleEllipsis(value)).toBe(`${expectedHead}…${expectedTail}`)
    expect(middleEllipsis(value)).toBe('synth-…9f2ab61c@example.com')
  })

  it('the visible result always ends with the last N characters of the input (the distinguishing suffix)', () => {
    const value = 'synth-w4w7-9f2ab61c@example.com'
    const result = middleEllipsis(value)
    expect(result.endsWith(value.slice(-20))).toBe(true)
  })

  it('the visible result always starts with the first N characters of the input', () => {
    const value = 'synth-w4w7-9f2ab61c@example.com'
    const result = middleEllipsis(value)
    expect(result.startsWith(value.slice(0, 6))).toBe(true)
  })

  it('two REALISTIC email-shaped accounts sharing the same long prefix AND domain remain distinguishable', () => {
    // This is the named scenario, not a simplified stand-in: same 'synth-w4w7-' prefix,
    // same '@example.com' domain, differing only in the local-part suffix — exactly the
    // shape a plain end-ellipsis (or a too-short default tail) collapses into
    // 'synth-…xample.com' for every account. With the default tail=20, the full
    // distinguishing suffix survives.
    const a = middleEllipsis('synth-w4w7-aaaaaaaa@example.com')
    const b = middleEllipsis('synth-w4w7-bbbbbbbb@example.com')
    expect(a).toBe('synth-…aaaaaaaa@example.com')
    expect(b).toBe('synth-…bbbbbbbb@example.com')
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
