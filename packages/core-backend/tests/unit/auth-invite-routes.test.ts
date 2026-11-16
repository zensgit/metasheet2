import type { Request, Response } from 'express'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const authServiceMocks = vi.hoisted(() => ({
  login: vi.fn(),
  register: vi.fn(),
  refreshToken: vi.fn(),
  verifyToken: vi.fn(),
  createToken: vi.fn(),
}))

const inviteTokenMocks = vi.hoisted(() => ({
  verifyInviteToken: vi.fn(),
}))

const pgMocks = vi.hoisted(() => ({
  query: vi.fn(),
  transaction: vi.fn(async (handler: (client: { query: typeof pgMocks.query }) => Promise<unknown>) =>
    handler({ query: pgMocks.query }),
  ),
}))

const bcryptMocks = vi.hoisted(() => ({
  hash: vi.fn(),
  compare: vi.fn(),
}))

const sessionMocks = vi.hoisted(() => ({
  revokeUserSessions: vi.fn(),
}))

vi.mock('../../src/auth/AuthService', () => ({
  authService: authServiceMocks,
}))

vi.mock('../../src/auth/invite-tokens', () => ({
  verifyInviteToken: inviteTokenMocks.verifyInviteToken,
}))

vi.mock('../../src/db/pg', () => ({
  query: pgMocks.query,
  transaction: pgMocks.transaction,
  // #4662's OAuth activation intent imports pool from db/pg; this suite never touches it.
  pool: { query: pgMocks.query },
}))

vi.mock('bcryptjs', () => bcryptMocks)

vi.mock('../../src/auth/session-revocation', () => ({
  revokeUserSessions: sessionMocks.revokeUserSessions,
}))

import { authRouter } from '../../src/routes/auth'

function createMockResponse() {
  return {
    statusCode: 200,
    body: undefined as unknown,
    headersSent: false,
    status(code: number) {
      this.statusCode = code
      return this
    },
    json(payload: unknown) {
      this.body = payload
      this.headersSent = true
      return this
    },
  } as Response & {
    statusCode: number
    body: unknown
    headersSent: boolean
  }
}

async function invokeRoute(
  method: 'get' | 'post',
  path: string,
  options: {
    query?: Record<string, unknown>
    body?: Record<string, unknown>
  } = {},
) {
  const layer = authRouter.stack.find((entry) => entry.route?.path === path && entry.route?.methods?.[method])
  if (!layer?.route?.stack) throw new Error(`Route ${method.toUpperCase()} ${path} not found`)

  const req = {
    method: method.toUpperCase(),
    url: path,
    headers: {},
    query: options.query ?? {},
    params: {},
    body: options.body ?? {},
    user: undefined,
    ip: '127.0.0.1',
    socket: { remoteAddress: '127.0.0.1' },
  } as unknown as Request

  const res = createMockResponse()

  for (const routeLayer of layer.route.stack) {
    await new Promise<void>((resolve, reject) => {
      try {
        const maybePromise = routeLayer.handle(req, res, (error?: unknown) => {
          if (error) reject(error)
          else resolve()
        })
        if (maybePromise && typeof maybePromise.then === 'function') {
          Promise.resolve(maybePromise).then(() => resolve()).catch(reject)
        } else if (routeLayer.handle.length < 3) {
          resolve()
        }
      } catch (error) {
        reject(error)
      }
    })
  }

  return res
}

// What the ledger read answers while it holds the token on a pending row.
const LEDGER_PENDING = { rows: [{ pending: true }] }

describe('auth invite routes', () => {
  beforeEach(() => {
    authServiceMocks.login.mockReset()
    authServiceMocks.register.mockReset()
    authServiceMocks.refreshToken.mockReset()
    authServiceMocks.verifyToken.mockReset()
    authServiceMocks.createToken.mockReset()
    inviteTokenMocks.verifyInviteToken.mockReset()
    pgMocks.query.mockReset()
    pgMocks.transaction.mockClear()
    pgMocks.transaction.mockImplementation(
      async (handler: (client: { query: typeof pgMocks.query }) => Promise<unknown>) =>
        handler({ query: pgMocks.query }),
    )
    bcryptMocks.hash.mockReset()
    bcryptMocks.compare.mockReset()
    sessionMocks.revokeUserSessions.mockReset()
  })

  it('returns invite preview for a valid token', async () => {
    inviteTokenMocks.verifyInviteToken.mockReturnValue({
      type: 'invite',
      userId: 'user-1',
      email: 'alpha@example.com',
      presetId: 'attendance-employee',
    })
    pgMocks.query
      // The ledger holds this token on a pending row.
      .mockResolvedValueOnce({ rows: [{ pending: true }] })
      .mockResolvedValueOnce({
        rows: [{
          id: 'user-1',
          email: 'alpha@example.com',
          name: 'Alpha',
          is_active: false,
          updated_at: '2026-03-13T00:00:00.000Z',
        }],
      })

    const response = await invokeRoute('get', '/invite/preview', {
      query: { token: 'invite-preview-token' },
    })

    expect(response.statusCode).toBe(200)
    const ledgerSql = String(pgMocks.query.mock.calls[0]?.[0] || '').replace(/\s+/g, ' ')
    expect(ledgerSql).toContain("FROM user_invites WHERE invite_token = $1 AND status = 'pending'")
    expect(pgMocks.query.mock.calls[0]?.[1]).toEqual(['invite-preview-token'])
    expect(String(pgMocks.query.mock.calls[1]?.[0] || '')).toContain('FROM users')
    expect((response.body as Record<string, any>).data.user).toMatchObject({
      id: 'user-1',
      email: 'alpha@example.com',
      isActive: false,
    })
    expect((response.body as Record<string, any>).data.onboarding.productMode).toBe('attendance')
    expect(String((response.body as Record<string, any>).data.onboarding.acceptInviteUrl)).toContain('invite-preview-token')
  })

  // An invite token is usable only while the ledger holds it on a pending row. A revoked invite, a
  // token replaced by a later one and a token the ledger never recorded all read as "no pending row".
  it('refuses an invite preview when the ledger holds no pending row for the token, before reading the account', async () => {
    inviteTokenMocks.verifyInviteToken.mockReturnValue({
      type: 'invite',
      userId: 'user-1',
      email: 'alpha@example.com',
      presetId: 'attendance-employee',
    })
    pgMocks.query.mockResolvedValueOnce({ rows: [] })

    const response = await invokeRoute('get', '/invite/preview', {
      query: { token: 'invite-superseded-token' },
    })

    expect(response.statusCode).toBe(409)
    expect(response.body).toEqual({
      success: false,
      error: 'Invite is no longer valid',
      code: 'INVITE_NOT_PENDING',
    })
    expect(pgMocks.query).toHaveBeenCalledTimes(1)
    expect(String(pgMocks.query.mock.calls[0]?.[0] || '')).toContain('user_invites')
    expect(pgMocks.query.mock.calls.some((call) => String(call[0]).includes('FROM users'))).toBe(false)
  })

  it('refuses an invite preview when the invite ledger cannot be read because its table is missing', async () => {
    inviteTokenMocks.verifyInviteToken.mockReturnValue({
      type: 'invite',
      userId: 'user-1',
      email: 'alpha@example.com',
      presetId: 'attendance-employee',
    })
    pgMocks.query.mockRejectedValueOnce(
      Object.assign(new Error('relation "user_invites" does not exist'), { code: '42P01' }),
    )

    const response = await invokeRoute('get', '/invite/preview', {
      query: { token: 'invite-preview-token' },
    })

    expect(response.statusCode).toBe(409)
    expect((response.body as Record<string, any>).code).toBe('INVITE_NOT_PENDING')
    expect((response.body as Record<string, any>).data).toBeUndefined()
    expect(pgMocks.query).toHaveBeenCalledTimes(1)
  })

  it('does not answer an invite preview when the ledger read fails for any other reason', async () => {
    inviteTokenMocks.verifyInviteToken.mockReturnValue({
      type: 'invite',
      userId: 'user-1',
      email: 'alpha@example.com',
      presetId: 'attendance-employee',
    })
    pgMocks.query.mockRejectedValueOnce(new Error('synthetic failure'))

    const response = await invokeRoute('get', '/invite/preview', {
      query: { token: 'invite-preview-token' },
    })

    expect(response.statusCode).toBe(500)
    expect((response.body as Record<string, any>).data).toBeUndefined()
    expect(pgMocks.query).toHaveBeenCalledTimes(1)
  })

  // Acceptance follows the same rule as the preview, and answers before the password is looked at
  // and before anything about the invited account is read.
  it.each([
    ['a password that meets the policy', 'WelcomePass9A'],
    ['a password that does not meet the policy', 'weak'],
  ])('refuses invite acceptance when the ledger holds no pending row for the token, before reading the account (%s)', async (_label, password) => {
    inviteTokenMocks.verifyInviteToken.mockReturnValue({
      type: 'invite',
      userId: 'user-1',
      email: 'alpha@example.com',
      presetId: 'attendance-employee',
      iat: Math.floor(Date.now() / 1000) - 60,
    })
    pgMocks.query.mockResolvedValueOnce({ rows: [] })

    const response = await invokeRoute('post', '/invite/accept', {
      body: { token: 'invite-superseded-token', password },
    })

    expect(response.statusCode).toBe(409)
    expect(response.body).toEqual({
      success: false,
      error: 'Invite is no longer valid',
      code: 'INVITE_NOT_PENDING',
    })
    expect(pgMocks.query).toHaveBeenCalledTimes(1)
    const ledgerSql = String(pgMocks.query.mock.calls[0]?.[0] || '').replace(/\s+/g, ' ')
    expect(ledgerSql).toContain("FROM user_invites WHERE invite_token = $1 AND status = 'pending'")
    expect(pgMocks.query.mock.calls[0]?.[1]).toEqual(['invite-superseded-token'])
    expect(pgMocks.query.mock.calls.some((call) => String(call[0]).includes('FROM users'))).toBe(false)
    expect(bcryptMocks.hash).not.toHaveBeenCalled()
    expect(pgMocks.transaction).not.toHaveBeenCalled()
    expect(sessionMocks.revokeUserSessions).not.toHaveBeenCalled()
    expect(authServiceMocks.login).not.toHaveBeenCalled()
  })

  it('refuses invite acceptance when the invite ledger cannot be read because its table is missing', async () => {
    inviteTokenMocks.verifyInviteToken.mockReturnValue({
      type: 'invite',
      userId: 'user-1',
      email: 'alpha@example.com',
      presetId: 'attendance-employee',
    })
    pgMocks.query.mockRejectedValueOnce(
      Object.assign(new Error('relation "user_invites" does not exist'), { code: '42P01' }),
    )

    const response = await invokeRoute('post', '/invite/accept', {
      body: { token: 'invite-accept-token', password: 'WelcomePass9A' },
    })

    expect(response.statusCode).toBe(409)
    expect((response.body as Record<string, any>).code).toBe('INVITE_NOT_PENDING')
    expect(pgMocks.query).toHaveBeenCalledTimes(1)
    expect(bcryptMocks.hash).not.toHaveBeenCalled()
    expect(pgMocks.transaction).not.toHaveBeenCalled()
    expect(authServiceMocks.login).not.toHaveBeenCalled()
  })

  it('does not accept an invite when the ledger read fails for any other reason', async () => {
    inviteTokenMocks.verifyInviteToken.mockReturnValue({
      type: 'invite',
      userId: 'user-1',
      email: 'alpha@example.com',
      presetId: 'attendance-employee',
    })
    pgMocks.query.mockRejectedValueOnce(new Error('synthetic failure'))

    const response = await invokeRoute('post', '/invite/accept', {
      body: { token: 'invite-accept-token', password: 'WelcomePass9A' },
    })

    expect(response.statusCode).toBe(500)
    expect(pgMocks.query).toHaveBeenCalledTimes(1)
    expect(bcryptMocks.hash).not.toHaveBeenCalled()
    expect(pgMocks.transaction).not.toHaveBeenCalled()
    expect(authServiceMocks.login).not.toHaveBeenCalled()
  })

  it('rejects invite acceptance when password policy fails', async () => {
    inviteTokenMocks.verifyInviteToken.mockReturnValue({
      type: 'invite',
      userId: 'user-1',
      email: 'alpha@example.com',
      presetId: 'attendance-employee',
    })
    pgMocks.query.mockResolvedValueOnce(LEDGER_PENDING)

    const response = await invokeRoute('post', '/invite/accept', {
      body: {
        token: 'invite-accept-token',
        password: 'weak',
      },
    })

    expect(response.statusCode).toBe(400)
    expect((response.body as Record<string, any>).error).toBe('Password does not meet requirements')
    // `details` (English strings) is unchanged; `reasons` is the additive machine-readable list.
    expect((response.body as Record<string, any>).details).toEqual([
      'Password must be at least 8 characters long',
      'Password must contain at least one uppercase letter',
      'Password must contain at least one number',
    ])
    expect((response.body as Record<string, any>).reasons).toEqual(['too_short', 'no_uppercase', 'no_digit'])
    // Only the ledger was read; nothing about the account.
    expect(pgMocks.query).toHaveBeenCalledTimes(1)
    expect(String(pgMocks.query.mock.calls[0]?.[0] || '')).toContain('user_invites')
    expect(bcryptMocks.hash).not.toHaveBeenCalled()
  })

  it('accepts invite, updates password, revokes sessions, and logs the user in', async () => {
    inviteTokenMocks.verifyInviteToken.mockReturnValue({
      type: 'invite',
      userId: 'user-1',
      email: 'alpha@example.com',
      presetId: 'attendance-employee',
      iat: Math.floor(Date.now() / 1000) - 60,
    })
    pgMocks.query
      .mockResolvedValueOnce(LEDGER_PENDING)
      .mockResolvedValueOnce({
        rows: [{
          id: 'user-1',
          email: 'alpha@example.com',
          name: 'Alpha',
          is_active: false,
          activation_status: 'activated',
          updated_at: '2026-03-13T00:00:00.000Z',
        }],
      })
      // canonical users FOR UPDATE mutex
      .mockResolvedValueOnce({
        rows: [{
          id: 'user-1',
          email: 'alpha@example.com',
          username: null,
          mobile: null,
          is_active: false,
          activation_status: 'activated',
          access_generation: 0,
        }],
      })
      // markInviteAccepted FIRST (ledger-first) — must RETURNING non-empty
      .mockResolvedValueOnce({
        rows: [{
          id: 'invite-1',
          user_id: 'user-1',
          email: 'alpha@example.com',
          preset_id: 'attendance-employee',
          product_mode: 'attendance',
          role_id: 'attendance_employee',
          invited_by: 'admin-1',
          invite_token: 'invite-accept-token',
          status: 'accepted',
          accepted_at: '2026-03-13T00:05:00.000Z',
          consumed_by: 'user-1',
          last_sent_at: '2026-03-13T00:00:00.000Z',
          created_at: '2026-03-13T00:00:00.000Z',
          updated_at: '2026-03-13T00:05:00.000Z',
        }],
      })
      // UPDATE users ... RETURNING id (must be non-empty)
      .mockResolvedValueOnce({ rows: [{ id: 'user-1' }] })
      .mockResolvedValueOnce({ rows: [] }) // supersede effects
      .mockResolvedValueOnce({ rows: [] }) // supersede events
      .mockResolvedValueOnce({ rows: [{ access_generation: 1 }] })
    bcryptMocks.hash.mockResolvedValue('hashed-password')
    sessionMocks.revokeUserSessions.mockResolvedValue({ revokedAfter: '2026-03-13T00:05:00.000Z' })
    authServiceMocks.login.mockResolvedValue({
      user: {
        id: 'user-1',
        email: 'alpha@example.com',
        name: 'Alpha User',
        role: 'user',
        permissions: ['attendance:read'],
        created_at: new Date('2026-03-13T00:00:00.000Z'),
        updated_at: new Date('2026-03-13T00:00:00.000Z'),
      },
      token: 'jwt-after-invite',
    })

    const response = await invokeRoute('post', '/invite/accept', {
      body: {
        token: 'invite-accept-token',
        password: 'WelcomePass9A',
        name: 'Alpha User',
      },
    })

    expect(response.statusCode).toBe(200)
    expect(bcryptMocks.hash).toHaveBeenCalledWith('WelcomePass9A', 10)
    expect(pgMocks.transaction).toHaveBeenCalled()
    // The ledger is read first, then the account; the transaction then locks the account, consumes
    // the ledger row and writes the account.
    const ledgerReadSql = String(pgMocks.query.mock.calls[0]?.[0] || '').replace(/\s+/g, ' ')
    expect(ledgerReadSql).toContain("FROM user_invites WHERE invite_token = $1 AND status = 'pending'")
    expect(pgMocks.query.mock.calls[0]?.[1]).toEqual(['invite-accept-token'])
    expect(String(pgMocks.query.mock.calls[1]?.[0] || '')).toContain('FROM users')
    expect(String(pgMocks.query.mock.calls[2]?.[0] || '')).toContain('FOR UPDATE')
    expect(String(pgMocks.query.mock.calls[3]?.[0] || '')).toContain('UPDATE user_invites')
    expect(pgMocks.query).toHaveBeenNthCalledWith(
      5,
      expect.stringContaining('UPDATE users'),
      ['hashed-password', 'Alpha User', 'user-1', 'alpha@example.com'],
    )
    const updateSql = String(pgMocks.query.mock.calls[4]?.[0] || '')
    expect(updateSql).toContain('must_change_password = FALSE')
    expect(updateSql).toContain('local_password_set = TRUE')
    expect(updateSql).toContain('RETURNING id')
    expect(updateSql).toContain("activation_status = 'activated'")
    expect(pgMocks.query.mock.calls.some((call) =>
      String(call[0]).includes('UPDATE directory_deprovision_effects'))).toBe(true)
    expect(pgMocks.query.mock.calls.some((call) =>
      String(call[0]).includes('access_generation = COALESCE'))).toBe(true)
    expect(sessionMocks.revokeUserSessions).toHaveBeenCalledWith('user-1', expect.objectContaining({
      updatedBy: 'user-1',
      reason: 'invite-accepted',
    }))
    expect(authServiceMocks.login).toHaveBeenCalledWith(
      'alpha@example.com',
      'WelcomePass9A',
      expect.objectContaining({
        ipAddress: '127.0.0.1',
      }),
    )
    expect((response.body as Record<string, any>).data.token).toBe('jwt-after-invite')
    expect((response.body as Record<string, any>).data.features.attendance).toBe(true)
    expect((response.body as Record<string, any>).data.onboarding.homePath).toBe('/attendance')
  })

  it('rejects invite accept for pending_activation without writes', async () => {
    inviteTokenMocks.verifyInviteToken.mockReturnValue({
      type: 'invite',
      userId: 'user-1',
      email: 'pending@example.com',
      presetId: null,
      iat: Math.floor(Date.now() / 1000) - 60,
    })
    pgMocks.query.mockResolvedValueOnce(LEDGER_PENDING).mockResolvedValueOnce({
      rows: [{
        id: 'user-1',
        email: 'pending@example.com',
        name: 'Pending',
        is_active: false,
        activation_status: 'pending_activation',
        updated_at: '2026-03-13T00:00:00.000Z',
      }],
    })
    bcryptMocks.hash.mockResolvedValue('hashed-password')

    const response = await invokeRoute('post', '/invite/accept', {
      body: {
        token: 'invite-pending-token',
        password: 'WelcomePass9A',
      },
    })

    expect(response.statusCode).toBe(403)
    expect((response.body as Record<string, any>).code).toBe('ACCOUNT_PENDING_ACTIVATION')
    expect(pgMocks.transaction).not.toHaveBeenCalled()
    expect(sessionMocks.revokeUserSessions).not.toHaveBeenCalled()
    expect(authServiceMocks.login).not.toHaveBeenCalled()
    expect(pgMocks.query.mock.calls.some((call) =>
      String(call[0]).includes('directory_deprovision_effects'))).toBe(false)
  })

  it('stops with 409 when user UPDATE returns zero rows (ledger already claimed → txn rolls back)', async () => {
    inviteTokenMocks.verifyInviteToken.mockReturnValue({
      type: 'invite',
      userId: 'user-1',
      email: 'alpha@example.com',
      presetId: 'attendance-employee',
      iat: Math.floor(Date.now() / 1000) - 60,
    })
    pgMocks.query
      .mockResolvedValueOnce(LEDGER_PENDING)
      .mockResolvedValueOnce({
        rows: [{
          id: 'user-1',
          email: 'alpha@example.com',
          name: 'Alpha',
          is_active: true,
          activation_status: 'activated',
          updated_at: '2026-03-13T00:00:00.000Z',
        }],
      })
      .mockResolvedValueOnce({
        rows: [{
          id: 'user-1',
          email: 'alpha@example.com',
          username: null,
          mobile: null,
          is_active: true,
          activation_status: 'activated',
          access_generation: 0,
        }],
      })
      // Ledger consume succeeds
      .mockResolvedValueOnce({
        rows: [{
          id: 'invite-1',
          user_id: 'user-1',
          email: 'alpha@example.com',
          preset_id: 'attendance-employee',
          product_mode: 'attendance',
          role_id: null,
          invited_by: 'admin-1',
          invite_token: 'invite-accept-token',
          status: 'accepted',
          accepted_at: '2026-03-13T00:05:00.000Z',
          consumed_by: 'user-1',
          last_sent_at: '2026-03-13T00:00:00.000Z',
          created_at: '2026-03-13T00:00:00.000Z',
          updated_at: '2026-03-13T00:05:00.000Z',
        }],
      })
      // Zero-row user UPDATE (race / activation drift) → throw rolls back ledger too
      .mockResolvedValueOnce({ rows: [] })
    bcryptMocks.hash.mockResolvedValue('hashed-password')

    const response = await invokeRoute('post', '/invite/accept', {
      body: {
        token: 'invite-accept-token',
        password: 'WelcomePass9A',
      },
    })

    expect(response.statusCode).toBe(409)
    expect((response.body as Record<string, any>).code).toBe('INVITE_TARGET_UPDATE_MISMATCH')
    expect(String(pgMocks.query.mock.calls[3]?.[0] || '')).toContain('UPDATE user_invites')
    expect(String(pgMocks.query.mock.calls[4]?.[0] || '')).toContain('UPDATE users')
    expect(sessionMocks.revokeUserSessions).not.toHaveBeenCalled()
    expect(authServiceMocks.login).not.toHaveBeenCalled()
  })

  // The ledger read before the transaction is not the authority: a row that stops being pending
  // after that read is refused by the consume inside the transaction, and nothing is written.
  it('stops with 409 when the ledger consume inside the transaction returns no row', async () => {
    inviteTokenMocks.verifyInviteToken.mockReturnValue({
      type: 'invite',
      userId: 'user-1',
      email: 'alpha@example.com',
      presetId: 'attendance-employee',
      iat: Math.floor(Date.now() / 1000) - 60,
    })
    pgMocks.query
      .mockResolvedValueOnce(LEDGER_PENDING)
      .mockResolvedValueOnce({
        rows: [{
          id: 'user-1',
          email: 'alpha@example.com',
          name: 'Alpha',
          is_active: true,
          activation_status: 'activated',
          updated_at: '2026-03-13T00:00:00.000Z',
        }],
      })
      .mockResolvedValueOnce({
        rows: [{
          id: 'user-1',
          email: 'alpha@example.com',
          username: null,
          mobile: null,
          is_active: true,
          activation_status: 'activated',
          access_generation: 0,
        }],
      })
      // Ledger consume zero rows (no longer pending by the time the transaction runs)
      .mockResolvedValueOnce({ rows: [] })
    bcryptMocks.hash.mockResolvedValue('hashed-password')

    const response = await invokeRoute('post', '/invite/accept', {
      body: {
        token: 'invite-missing-ledger',
        password: 'WelcomePass9A',
      },
    })

    expect(response.statusCode).toBe(409)
    expect((response.body as Record<string, any>).code).toBe('INVITE_LEDGER_CONSUME_FAILED')
    // ledger read + getInviteTarget + user mutex + ledger UPDATE only; password write must not run
    expect(pgMocks.query).toHaveBeenCalledTimes(4)
    expect(String(pgMocks.query.mock.calls[3]?.[0] || '')).toContain('UPDATE user_invites')
    expect(sessionMocks.revokeUserSessions).not.toHaveBeenCalled()
    expect(authServiceMocks.login).not.toHaveBeenCalled()
  })

  it('stops with 409 when the invite is revoked after the ledger read (status != pending → zero RETURNING)', async () => {
    inviteTokenMocks.verifyInviteToken.mockReturnValue({
      type: 'invite',
      userId: 'user-1',
      email: 'alpha@example.com',
      presetId: 'attendance-employee',
      iat: Math.floor(Date.now() / 1000) - 60,
    })
    pgMocks.query
      .mockResolvedValueOnce(LEDGER_PENDING)
      .mockResolvedValueOnce({
        rows: [{
          id: 'user-1',
          email: 'alpha@example.com',
          name: 'Alpha',
          is_active: true,
          activation_status: 'activated',
          updated_at: '2026-03-13T00:00:00.000Z',
        }],
      })
      .mockResolvedValueOnce({
        rows: [{
          id: 'user-1',
          email: 'alpha@example.com',
          username: null,
          mobile: null,
          is_active: true,
          activation_status: 'activated',
          access_generation: 0,
        }],
      })
      // UPDATE ... WHERE status='pending' matches nothing for revoked rows
      .mockResolvedValueOnce({ rows: [] })
    bcryptMocks.hash.mockResolvedValue('hashed-password')

    const response = await invokeRoute('post', '/invite/accept', {
      body: {
        token: 'invite-revoked-token',
        password: 'WelcomePass9A',
      },
    })

    expect(response.statusCode).toBe(409)
    expect((response.body as Record<string, any>).code).toBe('INVITE_LEDGER_CONSUME_FAILED')
    expect(pgMocks.query.mock.calls.some((call) => String(call[0]).includes('UPDATE users'))).toBe(false)
    expect(authServiceMocks.login).not.toHaveBeenCalled()
  })

  // Concurrent single-winner + real ROLLBACK are proven against Postgres in
  // tests/integration/invite-accept-concurrency-rollback.db.test.ts (not mock memory).
})
