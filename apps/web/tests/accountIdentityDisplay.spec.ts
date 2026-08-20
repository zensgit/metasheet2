import { describe, expect, it } from 'vitest'
import { truncateAccountIdentity } from '../src/utils/accountIdentityDisplay'
import { middleEllipsis } from '../src/utils/middleEllipsis'

/**
 * Real staging-trial account shapes (GATE-5047 P1), verbatim from the seeder at this head:
 *   scripts/ops/attendance-staging-window-runner-remote.sh:184  SOAK_USER_PREFIX="synth-w4w7-"
 *   :1813  prefix="${SOAK_USER_PREFIX}${org:0:8}-u"
 *   :1385  email = user_prefix || lpad(i,2,'0') || '@w4w7-soak.synthetic'
 * -> 'synth-w4w7-<org8>-u<NN>@w4w7-soak.synthetic', 43 chars, 20-char domain. A plain
 * fixed-length tail (see middleEllipsis's own default, tail=20) lands exactly on the '@'
 * for this shape and keeps ONLY the domain — every account in the org renders identically.
 * truncateAccountIdentity fixes this by dropping the domain and keeping the local-part
 * tail instead, browser-measured (see PR body) to be the only candidate that survives down
 * to the narrowest tested viewport.
 */
const REAL_ACCOUNTS = [
  ['synth-w4w7-853b767f-u01@w4w7-soak.synthetic', '…853b767f-u01'],
  ['synth-w4w7-853b767f-u02@w4w7-soak.synthetic', '…853b767f-u02'],
  ['synth-w4w7-3f62c6e4-u01@w4w7-soak.synthetic', '…3f62c6e4-u01'],
  ['synth-w4w7-d5c1a9cf-u01@w4w7-soak.synthetic', '…d5c1a9cf-u01'],
] as const

describe('truncateAccountIdentity — real staging-trial email shapes', () => {
  it.each(REAL_ACCOUNTS)('renders %s as the exact expected local-part-tail shape %s', (input, expected) => {
    expect(truncateAccountIdentity(input)).toBe(expected)
  })

  it('all four REAL trial accounts (same 20-char domain, same shared prefix) render as four DISTINCT strings', () => {
    const outputs = REAL_ACCOUNTS.map(([input]) => truncateAccountIdentity(input))
    expect(new Set(outputs).size).toBe(REAL_ACCOUNTS.length)
  })

  it('negative control: the OLD generic middleEllipsis on the same real shape collapses two same-org accounts to one string', () => {
    // Documents exactly the regression this module fixes: without the email-aware branch,
    // the generic tail=20 truncation keeps only the domain for this exact shape.
    const a = middleEllipsis(REAL_ACCOUNTS[0][0])
    const b = middleEllipsis(REAL_ACCOUNTS[1][0])
    expect(a).toBe(b)
    expect(a).toBe('synth-…@w4w7-soak.synthetic')
  })
})

describe('truncateAccountIdentity — general contract', () => {
  it('returns short values (including short emails) unchanged', () => {
    expect(truncateAccountIdentity('alice@corp.com')).toBe('alice@corp.com')
    expect(truncateAccountIdentity('a@b.io')).toBe('a@b.io')
    expect(truncateAccountIdentity('short')).toBe('short')
    expect(truncateAccountIdentity('')).toBe('')
  })

  it('returns values exactly at the threshold unchanged (default maxLength = 27)', () => {
    const exactEmail = 'synth-w4w7-853b767f-u01' // bare username, 23 chars, no '@' — under 27
    expect(truncateAccountIdentity(exactEmail)).toBe(exactEmail)
  })

  it('drops the domain and keeps the local-part tail for a long email whose local part exceeds the tail length', () => {
    const value = 'synth-w4w7-853b767f-u01@w4w7-soak.synthetic'
    expect(truncateAccountIdentity(value)).toBe('…853b767f-u01')
  })

  it('marks the value with a trailing ellipsis (GATE-5047 P3-4) when the local part itself is at or under the tail length, so a dropped domain is never silently invisible', () => {
    const value = 'ab@some-extremely-long-domain-name.example' // local part 'ab', 2 chars <= 12
    expect(truncateAccountIdentity(value)).toBe('ab…')
  })

  it('a leading "@" (empty local part) is NOT treated as email-shaped — falls through to the generic path', () => {
    const value = '@nolocalpart-but-long-enough-to-trigger.example' // at === 0
    expect(truncateAccountIdentity(value)).toBe(middleEllipsis(value, { maxLength: 27 }))
  })

  it('a trailing "@" (empty domain) is NOT treated as email-shaped — falls through to the generic path', () => {
    const value = 'this-is-a-long-value-with-trailing-at@' // at === value.length - 1
    expect(truncateAccountIdentity(value)).toBe(middleEllipsis(value, { maxLength: 27 }))
  })

  it('a long non-email value falls through to middleEllipsis with the same maxLength', () => {
    const value = 'HEAD01-0123456789-0123456789-TAIL01' // no '@', 35 chars
    expect(truncateAccountIdentity(value)).toBe(middleEllipsis(value, { maxLength: 27 }))
  })

  it('respects a custom emailLocalTailLength', () => {
    const value = 'synth-w4w7-853b767f-u01@w4w7-soak.synthetic'
    expect(truncateAccountIdentity(value, { emailLocalTailLength: 4 })).toBe('…-u01')
    expect(truncateAccountIdentity(value, { emailLocalTailLength: 0 })).toBe('…')
  })

  it('respects a custom maxLength (raises the no-op threshold)', () => {
    const value = 'synth-w4w7-853b767f-u01@w4w7-soak.synthetic' // 43 chars
    expect(truncateAccountIdentity(value, { maxLength: 50 })).toBe(value)
  })

  it('returns an empty string for null/undefined input', () => {
    expect(truncateAccountIdentity(null)).toBe('')
    expect(truncateAccountIdentity(undefined)).toBe('')
  })

  it('documents the known suffix-priority limitation (GATE-5047 P3-4): two long local parts distinguished by a PREFIX collide on the tail, same as the domain-tail bug this module fixes', () => {
    // Neither account name is the real staging shape (which is distinguished by a tail) —
    // this is a deliberately different naming scheme to prove the tail-keeping strategy is
    // not a general solution. `title` (not asserted here — that's App.spec.ts's concern)
    // is the documented recovery path for this case.
    const alice = truncateAccountIdentity('alice.smith.engineering@example-corp.com')
    const bob = truncateAccountIdentity('bob.smith.engineering@example-corp.com')
    expect(alice).toBe(bob)
    expect(alice).toBe('….engineering')
  })
})
