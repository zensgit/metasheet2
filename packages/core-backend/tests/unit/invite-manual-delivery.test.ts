import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { deliverInviteManually, ManualDeliveryConflict } from '../../src/auth/invite-manual-delivery'
import { validatePassword } from '../../src/auth/password-policy'

const mocks = vi.hoisted(() => ({ query: vi.fn(), verify: vi.fn(), hash: vi.fn() }))
vi.mock('../../src/db/pg', () => ({
  transaction: (work: (client: { query: typeof mocks.query }) => unknown) => work({ query: mocks.query }),
}))
vi.mock('../../src/auth/invite-tokens', () => ({ verifyInviteToken: mocks.verify }))
vi.mock('bcryptjs', () => ({ hash: mocks.hash }))

const user = { email: 'target@example.test', updated_at: new Date(100_000) }
const invite = { id: 'invite', email: user.email, status: 'pending', accepted_at: null, consumed_by: null, invite_token: 'latest' }
const token = { userId: 'target', email: user.email, iat: 100, exp: 200 }
const target = { id: 'target' }
const operator = { id: 'operator' }
function queue(...results: unknown[][]) {
  for (const rows of results) mocks.query.mockResolvedValueOnce({ rows })
}
function start() {
  queue([], [{ user_id: 'target' }], [user])
}
const deliver = () => deliverInviteManually('invite', 'operator')

describe('manual invitation delivery', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    vi.stubEnv('AUTH_LOGIN_USE_ALIASES', 'false')
    mocks.verify.mockReturnValue(token)
    mocks.hash.mockResolvedValue('new-hash')
  })
  afterEach(() => vi.unstubAllEnvs())

  it.each([false, true])('returns only credentials after all three writes (aliases=%s)', async (aliases) => {
    vi.stubEnv('AUTH_LOGIN_USE_ALIASES', String(aliases))
    start()
    queue([invite], [operator], [])
    if (aliases) queue([{ n: 1 }])
    queue([target], [invite], [target], [{ id: 1 }])
    const result = await deliver()
    expect(result).toEqual({ loginIdentifier: user.email, temporaryPassword: expect.any(String) })
    expect(mocks.hash).toHaveBeenCalledWith(result.temporaryPassword, expect.any(Number))
    expect(validatePassword(result.temporaryPassword).valid).toBe(true)
    expect(mocks.verify).toHaveBeenCalledWith('latest')
    const statements = mocks.query.mock.calls.map(([sql]) => sql)
    expect(statements[0]).toContain('READ COMMITTED')
    expect(statements[2]).toMatch(/FROM users[\s\S]*FOR UPDATE/)
    expect(statements[3]).toMatch(/FROM user_invites[\s\S]*FOR UPDATE/)
    expect(mocks.query.mock.calls[4]).toEqual([expect.stringMatching(
      /FROM users u JOIN user_roles membership ON membership.user_id = u.id\s+WHERE u.id = \$1 AND u.is_active AND u.activation_status = 'activated'\s+AND u.deleted_at IS NULL AND u.purged_at IS NULL AND membership.role_id = 'admin'\s+FOR SHARE OF u, membership$/,
    ), ['operator']])
    expect(statements[5]).toContain('FROM user_sessions WHERE user_id = $1 LIMIT 1')
    expect(statements.at(-3)).toContain("status = 'manual_delivery'")
    expect(statements.at(-2)).toContain('access_generation = access_generation + 1')
    expect(mocks.query.mock.calls.at(-2)?.[1]).toEqual(['target', 'new-hash'])
    expect(mocks.query.mock.calls.at(-1)).toEqual([expect.stringContaining('INSERT INTO audit_logs'), ['invite', 'operator']])
    expect(JSON.stringify(mocks.query.mock.calls)).not.toContain(result.temporaryPassword)
  })

  it.each([
    [], [invite, invite], [{ ...invite, status: 'manual_delivery' }], [{ ...invite, status: 'accepted' }],
    [{ ...invite, accepted_at: 'used' }], [{ ...invite, consumed_by: 'other' }], [{ ...invite, email: 'other' }],
  ].map(rows => ({ rows })))('rejects missing, multiple or ineligible ledger rows', async ({ rows }) => {
    start()
    queue(rows)
    await expect(deliver()).rejects.toBeInstanceOf(ManualDeliveryConflict)
    expect(mocks.verify).not.toHaveBeenCalled()
  })

  it.each([null, { ...token, email: 'other' }, { ...token, userId: 'other' }, { ...token, iat: 98 },
    { ...token, exp: undefined }])('rejects unverifiable or mismatched token', async (payload) => {
    start()
    queue([invite], [operator])
    mocks.verify.mockReturnValue(payload)
    await expect(deliver()).rejects.toBeInstanceOf(ManualDeliveryConflict)
    expect(mocks.hash).not.toHaveBeenCalled()
  })

  it.each([
    { actor: 'target', results: [[], [{ user_id: 'target' }]] },
    { actor: 'operator', results: [[], [{ user_id: 'target' }], []] },
  ])('rejects self or ineligible target', async ({ actor, results }) => {
    queue(...results)
    await expect(deliverInviteManually('invite', actor)).rejects.toBeInstanceOf(ManualDeliveryConflict)
    expect(mocks.hash).not.toHaveBeenCalled()
  })

  it.each([
    { aliases: false, results: [[{ revoked_at: 'yesterday' }], [target], [invite], [target], [{ id: 1 }]] },
    { aliases: false, results: [[], [target, { id: 'other' }]] },
    { aliases: true, results: [[], [{ n: 0 }]] },
    { aliases: true, results: [[], [{ n: 1 }], [{ id: 'other' }]] },
  ])('rejects prior sessions or unproven login resolution', async ({ aliases, results }) => {
    vi.stubEnv('AUTH_LOGIN_USE_ALIASES', String(aliases))
    start()
    queue([invite], [operator], ...results)
    await expect(deliver()).rejects.toBeInstanceOf(ManualDeliveryConflict)
    expect(mocks.hash).not.toHaveBeenCalled()
  })

  it('throws from the transaction when the audit insert does not persist', async () => {
    start()
    queue([invite], [operator], [], [target], [invite], [target], [])
    await expect(deliver()).rejects.toThrow('INVITE_AUDIT_FAILED')
  })
})
