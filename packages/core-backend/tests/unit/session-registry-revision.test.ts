import { beforeEach, expect, it, vi } from 'vitest'
import { createUserSession } from '../../src/auth/session-registry'
import { isUserSessionRevoked } from '../../src/auth/session-revocation'

const mocks = vi.hoisted(() => ({ query: vi.fn(), local: vi.fn(), rollback: vi.fn() }))
vi.mock('../../src/db/pg', () => ({
  query: mocks.query,
  transaction: async (work: (client: { query: typeof mocks.local }) => Promise<unknown>) => {
    try { return await work({ query: mocks.local }) } catch (error) {
      mocks.rollback()
      throw error
    }
  },
}))
const options = { sessionId: 'sid', expiresAt: new Date(200_000).toISOString(), expectedAccessGeneration: 7 }
const revision = '12345678-0000-4000-8000-123456789012'
beforeEach(() => vi.resetAllMocks())

it.each([
  { fence: { expectedSessionRevision: 'none' }, rows: [], accepted: true },
  { fence: { expectedSessionRevision: revision }, rows: [{ revision }], accepted: true },
  { fence: { expectedSessionRevision: 'none' }, rows: [{ revision }], accepted: false },
  { fence: { expectedSessionRevision: revision }, rows: [], accepted: false },
  { fence: { expectedRevocationIat: 100 }, rows: [{ revoked_after: new Date(100_000) }], accepted: false },
  { fence: { expectedRevocationIat: 101 }, rows: [{ revoked_after: new Date(100_999) }], accepted: true },
])('commits only if post-lock revision or original legacy time matches: $fence / $accepted', async ({ fence, rows, accepted }) => {
  mocks.local.mockResolvedValueOnce({ rows: [] })
    .mockResolvedValueOnce({ rows: [{ id: 'sid', user_id: 'user' }] }).mockResolvedValueOnce({ rows })
  const session = await createUserSession('user', { ...options, ...fence, requireExistingSession: true })
  expect(Boolean(session)).toBe(accepted)
  expect(mocks.rollback).toHaveBeenCalledTimes(accepted ? 0 : 1)
  expect(mocks.local.mock.calls[0][0]).toContain('READ COMMITTED')
  expect(mocks.local.mock.calls[1][0]).toContain('=$6::bigint) FOR SHARE')
  expect(mocks.local.mock.calls[1][0]).toContain('user_id=$2 AND revoked_at IS NULL FOR UPDATE')
  expect(mocks.local.mock.calls[2]).toEqual(['SELECT revision, revoked_after FROM user_session_revocations WHERE user_id=$1 FOR SHARE', ['user']])
  expect(mocks.query).not.toHaveBeenCalled()
})

it('does not substitute a synthetic session or a missing watermark when the revision schema is missing', async () => {
  const missing = Object.assign(new Error('missing column'), { code: '42703' })
  mocks.local.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [{ id: 'sid' }] }).mockRejectedValueOnce(missing)
  await expect(createUserSession('user', { ...options, expectedSessionRevision: 'none' })).rejects.toBe(missing)
  expect(mocks.rollback).toHaveBeenCalledOnce()
  mocks.query.mockRejectedValue(missing)
  await expect(isUserSessionRevoked('user', { sid: 'sid', iat: 10, sessionRevision: 'none' })).rejects.toBe(missing)
})

it('retains the inclusive watermark for existing numeric callers', async () => {
  mocks.query.mockResolvedValue({ rows: [{ revision, revoked_after: new Date(100_500) }] })
  expect(await isUserSessionRevoked('user', 100)).toBe(true)
  expect(await isUserSessionRevoked('user', 101)).toBe(false)
})
