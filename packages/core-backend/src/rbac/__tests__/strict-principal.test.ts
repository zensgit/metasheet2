import { beforeEach, describe, expect, it, vi } from 'vitest'
import { hasLiveRbacAdmin, readStrictPrincipal, validateStrictSession, type StrictPrincipalQuery } from '../strict-principal'
import { authService } from '../../auth/AuthService'

vi.mock('../../auth/AuthService', () => ({ authService: { readTokenPayload: vi.fn() } }))

const valid = { id: 'actor', role: 'admin', is_active: true, activation_status: 'activated', deleted_at: null, purged_at: null }
function queryFor(user: unknown = valid, revoked: unknown[] = [], sessions: unknown[] = [{}]): StrictPrincipalQuery {
  return vi.fn(async (sql) => {
    if (sql.includes('FROM users')) return { rows: user ? [user] : [] }
    if (sql.includes('user_session_revocations')) return { rows: revoked }
    if (sql.includes('user_sessions')) return { rows: sessions }
    if (sql.includes('user_roles')) return { rows: [] }
    throw new Error('unexpected query')
  })
}

beforeEach(() => vi.mocked(authService.readTokenPayload).mockReturnValue({ userId: 'actor', email: '', role: 'user', iat: 10, exp: 100, sid: 'session' }))

describe('strict principal', () => {
  it.each([
    null,
    { ...valid, is_active: null },
    { ...valid, is_active: false },
    { ...valid, role: 'disabled' },
    { ...valid, activation_status: null },
    { ...valid, activation_status: 'pending_activation' },
    { ...valid, deleted_at: '2020-01-01' },
    { ...valid, purged_at: '2020-01-01' },
  ])('rejects unavailable and inactive principals', async (row) => {
    expect(await readStrictPrincipal(queryFor(row), 'actor')).toBeNull()
  })

  it('accepts an active authenticated session', async () => {
    expect(await validateStrictSession(queryFor(), 'token', 'actor')).toBe(true)
  })

  it.each([
    ['current', 'session', true, true],
    ['stale', 'session', true, false],
    ['invalid', 'session', false, false],
    ['none', 'session', true, false],
    ['none', 'session', false, true],
    ['current', 'session', false, false],
    ['current', undefined, true, false],
  ] as const)('checks revision %s, sid %s and row present %s', async (kind, sid, present, allowed) => {
    const revision = '857618f2-07de-4097-bc24-9a41c4267cf2'
    const sessionRevision = kind === 'current' ? revision : kind === 'stale' ? '96dceee3-49e2-4794-a829-f2a3278aeb2a' : kind
    vi.mocked(authService.readTokenPayload).mockReturnValueOnce({ userId: 'actor', email: '', role: 'user', iat: 10, exp: 100, sid, sessionRevision })
    const query = queryFor(valid, present ? [{ revision, revoked_after: new Date(10500) }] : [])
    expect(await validateStrictSession(query, 'token', 'actor')).toBe(allowed)
    expect(query).toHaveBeenCalledWith(expect.stringMatching(/SELECT [^;]*\brevision\b FROM user_session_revocations/), ['actor'])
  })

  it('keeps the original revocation time on a refreshed legacy session', async () => {
    vi.mocked(authService.readTokenPayload).mockReturnValueOnce({ userId: 'actor', email: '', role: 'user', sid: 'session', iat: 12, revocationIat: 10, exp: 100 })
    expect(await validateStrictSession(queryFor(valid, [{ revoked_after: new Date(10500) }]), 'token', 'actor')).toBe(false)
  })

  it('does not substitute no-row for a missing revision column or a missing live session', async () => {
    const payload = { userId: 'actor', email: '', role: 'user', sid: 'session', iat: 10, exp: 100, sessionRevision: 'none' }
    vi.mocked(authService.readTokenPayload).mockReturnValue(payload)
    const base = queryFor(valid, [], [])
    await expect(validateStrictSession(async (sql, params) => {
      if (sql.includes('user_session_revocations')) throw new Error('missing revision')
      return base(sql, params)
    }, 'token', 'actor')).rejects.toThrow('missing revision')
    expect(await validateStrictSession(base, 'token', 'actor')).toBe(false)
  })

  it('accepts a legacy JWT without sid after strict session schema checks', async () => {
    vi.mocked(authService.readTokenPayload).mockReturnValueOnce({ userId: 'actor', email: '', role: 'user', iat: 10, exp: 100 })
    expect(await validateStrictSession(queryFor(valid, [], []), 'token', 'actor')).toBe(true)
  })

  it('rejects identity mismatch, invalid issued time, revocation and missing session', async () => {
    vi.mocked(authService.readTokenPayload).mockReturnValueOnce(null)
    expect(await validateStrictSession(queryFor(), 'token', 'actor')).toBe(false)
    expect(await validateStrictSession(queryFor(), 'token', 'other')).toBe(false)
    vi.mocked(authService.readTokenPayload).mockReturnValueOnce({ userId: 'actor', email: '', role: 'user', iat: NaN, exp: 100 })
    expect(await validateStrictSession(queryFor(), 'token', 'actor')).toBe(false)
    expect(await validateStrictSession(queryFor(valid, [{ revoked_after: new Date(10000) }]), 'token', 'actor')).toBe(false)
    expect(await validateStrictSession(queryFor(valid, [{ revoked_after: 'invalid' }]), 'token', 'actor')).toBe(false)
    expect(await validateStrictSession(queryFor(valid, [], []), 'token', 'actor')).toBe(false)
  })

  it('propagates a missing session table instead of treating it as active', async () => {
    const query: StrictPrincipalQuery = async sql => {
      if (sql.includes('FROM users')) return { rows: [valid] }
      throw new Error('schema unavailable')
    }
    await expect(validateStrictSession(query, 'token', 'actor')).rejects.toThrow('schema unavailable')
  })

  it('requires RBAC membership even when the raw principal role is admin', async () => {
    expect(await readStrictPrincipal(queryFor(), 'actor')).not.toBeNull()
    expect(await hasLiveRbacAdmin(queryFor(), 'actor')).toBe(false)
    expect(await hasLiveRbacAdmin(async () => ({ rows: [{}] }), 'actor')).toBe(true)
  })
})
