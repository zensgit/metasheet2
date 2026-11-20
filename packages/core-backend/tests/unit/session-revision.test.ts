import { describe, expect, it } from 'vitest'
import { sessionRevisionAllows } from '../../src/auth/session-revision'

const revision = '6c3ac20b-14c8-4e93-85e7-df85e3d71ed7'
const claims = { sid: 'registered', iat: 120, sessionRevision: revision }
const row = { revoked_after: new Date(120050), revision }

describe('session revocation evidence', () => {
  it('requires the precise revision and a numbered session even if the timestamp would pass', () => {
    expect(sessionRevisionAllows(claims, row)).toBe(true)
    expect(sessionRevisionAllows({ ...claims, iat: 121 }, { ...row, revision: 'other' })).toBe(false)
    expect(sessionRevisionAllows({ ...claims, sid: undefined }, row)).toBe(false)
    expect(sessionRevisionAllows({ ...claims, revocationIat: 119 }, row)).toBe(false)
  })

  it('distinguishes an absent watermark from an unreadable revision', () => {
    const initial = { ...claims, sessionRevision: 'none' }
    expect(sessionRevisionAllows(initial, undefined)).toBe(true)
    expect(sessionRevisionAllows(initial, row)).toBe(false)
    expect(sessionRevisionAllows(initial, { revision: undefined })).toBe(false)
    expect(sessionRevisionAllows(claims, undefined)).toBe(false)
    for (const invalid of [null, '', false, {}, 'NONE']) {
      expect(sessionRevisionAllows({ ...claims, sessionRevision: invalid }, undefined)).toBe(false)
    }
  })

  it('keeps the original cutoff on refreshed legacy credentials', () => {
    expect(sessionRevisionAllows({ iat: 121 }, row)).toBe(true)
    expect(sessionRevisionAllows({ sid: 'registered', iat: 121, revocationIat: 120 }, row)).toBe(false)
    expect(sessionRevisionAllows({ sid: 'registered', iat: 122, revocationIat: 121 }, row)).toBe(true)
    expect(sessionRevisionAllows({ iat: 122, revocationIat: 121 }, row)).toBe(false)
    expect(sessionRevisionAllows({ iat: 121, revocationIat: 122 }, undefined)).toBe(false)
    expect(sessionRevisionAllows({ iat: 121 }, {})).toBe(false)
  })
})
