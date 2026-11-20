import { afterEach, expect, it, vi } from 'vitest'
import { authService } from '../../src/auth/AuthService'
import { isUserSessionRevoked } from '../../src/auth/session-revocation'
import { validateStrictSession } from '../../src/rbac/strict-principal'

const { query } = vi.hoisted(() => ({ query: vi.fn() }))
vi.mock('../../src/db/pg', () => ({ query, pool: null }))

afterEach(() => vi.useRealTimers())

it('distinguishes the next issuance second, not two issuances on opposite sides of a cutoff in the same second', async () => {
  const start = Date.UTC(2026, 1, 1)
  const cutoff = new Date(start + 500)
  const user = { id: 'synthetic', name: 'Synthetic', email: 'example@example.test', role: 'user',
    permissions: [], created_at: new Date(start), updated_at: new Date(start) }
  query.mockImplementation(async (sql: string) => {
    if (sql.includes('FROM user_session_revocations')) return { rows: [{ revoked_after: cutoff, updated_at: cutoff }] }
    if (sql.includes('FROM users')) return { rows: [{ ...user, is_active: true, activation_status: 'activated' }] }
    if (sql.includes('FROM user_sessions')) return { rows: [{ id: 'live' }] }
    throw new Error('Unexpected query')
  })
  vi.useFakeTimers()
  for (const [offset, expectedActive] of [[100, false], [900, false], [1000, true]] as const) {
    vi.setSystemTime(start + offset)
    const token = authService.createToken(user, { sid: `synthetic-${offset}` })
    vi.setSystemTime(start + 1500)
    const issuedAt = authService.readTokenPayload(token)?.iat
    expect(issuedAt).toBe(Math.floor((start + offset) / 1000))
    expect(await isUserSessionRevoked(user.id, { iat: issuedAt })).toBe(!expectedActive)
    expect(await validateStrictSession(query, token, user.id)).toBe(expectedActive)
  }
})
