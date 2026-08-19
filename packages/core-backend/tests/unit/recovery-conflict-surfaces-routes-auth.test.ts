/**
 * O2-S2 — per-surface discriminating tests, HTTP layer (routes/auth.ts).
 *
 * Register: AuthService's REAL UserRoleAssignmentRecoveryBusyError (an exhausted-retry
 * member of the recovery-conflict family) must surface as the EXACT uniform retryable
 * 409 — not the generic 500. Invite accept: the named RecoveryConflictError produced by
 * applyInviteAcceptanceWrites (real module, db/pg mocked to raise the marker 40001)
 * surfaces the same way. Non-conflict errors keep their ORIGINAL bodies, asserted
 * positively.
 */

import type { Request, Response } from 'express'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const authServiceMocks = vi.hoisted(() => ({
  login: vi.fn(),
  register: vi.fn(),
  refreshToken: vi.fn(),
  verifyToken: vi.fn(),
  createToken: vi.fn(),
  resolveSessionTenantId: vi.fn(),
}))

const inviteTokenMocks = vi.hoisted(() => ({
  verifyInviteToken: vi.fn(),
}))

const pgMocks = vi.hoisted(() => ({
  query: vi.fn(),
  transaction: vi.fn(),
}))

const bcryptMocks = vi.hoisted(() => ({
  hash: vi.fn(),
  compare: vi.fn(),
}))

const sessionMocks = vi.hoisted(() => ({
  revokeUserSessions: vi.fn(),
}))

// O2-A1 census legs: the dingtalk-oauth / user-activate seams the remaining routes/auth.ts
// call sites await. Each leg rejects one seam with the NAMED RecoveryConflictError and
// asserts the exact uniform retryable 409 — dead-branching that route's
// sendIfRecoveryConflict (or the callback's classifyRecoveryConflict passthrough) reds it.
const dingtalkOauthMocks = vi.hoisted(() => ({
  validateState: vi.fn(),
  isDingTalkConfigured: vi.fn(),
  exchangeCodeForDingTalkProfile: vi.fn(),
  getDingTalkRuntimeStatus: vi.fn(),
  bindDingTalkIdentityToUser: vi.fn(),
  unbindSelfManagedDingTalkIdentity: vi.fn(),
  exchangeEnterpriseAuthCodeForUser: vi.fn(),
}))

const userActivateMocks = vi.hoisted(() => ({
  activatePendingUser: vi.fn(),
}))

const rbacMocks = vi.hoisted(() => ({
  isAdmin: vi.fn(),
  listUserPermissions: vi.fn(),
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
  pool: { query: pgMocks.query },
}))

vi.mock('bcryptjs', () => bcryptMocks)

vi.mock('../../src/auth/session-revocation', () => ({
  revokeUserSessions: sessionMocks.revokeUserSessions,
}))

vi.mock('../../src/auth/dingtalk-oauth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/auth/dingtalk-oauth')>()
  return {
    ...actual,
    validateState: dingtalkOauthMocks.validateState,
    isDingTalkConfigured: dingtalkOauthMocks.isDingTalkConfigured,
    exchangeCodeForDingTalkProfile: dingtalkOauthMocks.exchangeCodeForDingTalkProfile,
    getDingTalkRuntimeStatus: dingtalkOauthMocks.getDingTalkRuntimeStatus,
    bindDingTalkIdentityToUser: dingtalkOauthMocks.bindDingTalkIdentityToUser,
    unbindSelfManagedDingTalkIdentity: dingtalkOauthMocks.unbindSelfManagedDingTalkIdentity,
    exchangeEnterpriseAuthCodeForUser: dingtalkOauthMocks.exchangeEnterpriseAuthCodeForUser,
  }
})

vi.mock('../../src/auth/user-activate', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/auth/user-activate')>()
  return {
    ...actual,
    activatePendingUser: userActivateMocks.activatePendingUser,
  }
})

vi.mock('../../src/rbac/service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/rbac/service')>()
  return {
    ...actual,
    isAdmin: rbacMocks.isAdmin,
    listUserPermissions: rbacMocks.listUserPermissions,
  }
})

import { authRouter } from '../../src/routes/auth'
import {
  RECOVERY_CONFLICT_HTTP_CODE,
  RECOVERY_CONFLICT_HTTP_MESSAGE,
  RecoveryConflictError,
} from '../../src/db/recovery-conflict'
import { RECOVERY_AUTHORITY_BUSY_MARKER } from '../../src/multitable/recovery-authorization-stability'

// The REAL class from the REAL module — the mock above replaces the module for the
// route under test, so pull the actual constructor for a faithful injected error.
const { UserRoleAssignmentRecoveryBusyError } = await vi.importActual<
  typeof import('../../src/auth/AuthService')
>('../../src/auth/AuthService')

const UNIFORM_409_BODY = {
  ok: false,
  error: {
    code: RECOVERY_CONFLICT_HTTP_CODE,
    message: RECOVERY_CONFLICT_HTTP_MESSAGE,
    details: { retryable: true },
  },
}

function markerError(): Error & { code: string } {
  return Object.assign(new Error(RECOVERY_AUTHORITY_BUSY_MARKER), { code: '40001' })
}

function createMockResponse() {
  return {
    statusCode: 200,
    body: undefined as unknown,
    status(code: number) {
      this.statusCode = code
      return this
    },
    json(payload: unknown) {
      this.body = payload
      return this
    },
  } as Response & { statusCode: number; body: unknown }
}

async function invokeRoute(
  method: 'get' | 'post',
  path: string,
  options: { body?: Record<string, unknown>; headers?: Record<string, string> } = {},
) {
  const layer = authRouter.stack.find(
    (entry) => entry.route?.path === path && entry.route?.methods?.[method],
  )
  if (!layer?.route?.stack) throw new Error(`Route ${method.toUpperCase()} ${path} not found`)

  const req = {
    method: method.toUpperCase(),
    url: path,
    headers: options.headers ?? {},
    query: {},
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
        if (maybePromise && typeof (maybePromise as Promise<unknown>).then === 'function') {
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

beforeEach(() => {
  vi.unstubAllEnvs()
  authServiceMocks.register.mockReset()
  authServiceMocks.login.mockReset()
  authServiceMocks.verifyToken.mockReset()
  inviteTokenMocks.verifyInviteToken.mockReset()
  pgMocks.query.mockReset()
  pgMocks.transaction.mockReset()
  bcryptMocks.hash.mockReset()
  sessionMocks.revokeUserSessions.mockReset()
  for (const mock of Object.values(dingtalkOauthMocks)) mock.mockReset()
  userActivateMocks.activatePendingUser.mockReset()
  rbacMocks.isAdmin.mockReset()
  rbacMocks.listUserPermissions.mockReset()
})

describe('POST /register — UserRoleAssignmentRecoveryBusyError surfaces as retryable 409', () => {
  const body = { email: 'new@example.com', password: 'Str0ng!Passw0rd', name: 'New User' }

  it('[recovery-census:auth:register] the REAL named retryable error from AuthService → exact uniform retryable 409', async () => {
    authServiceMocks.register.mockRejectedValue(
      new UserRoleAssignmentRecoveryBusyError('user-1', ['attendance_employee'], markerError()),
    )
    const res = await invokeRoute('post', '/register', { body })
    expect(res.statusCode).toBe(409)
    expect(res.body).toEqual(UNIFORM_409_BODY)
  })

  it('a raw marker 40001 leak also surfaces as the same retryable 409', async () => {
    authServiceMocks.register.mockRejectedValue(markerError())
    const res = await invokeRoute('post', '/register', { body })
    expect(res.statusCode).toBe(409)
    expect(res.body).toEqual(UNIFORM_409_BODY)
  })

  it('any other failure keeps the ORIGINAL generic 500 body, exactly', async () => {
    authServiceMocks.register.mockRejectedValue(new Error('smtp exploded'))
    const res = await invokeRoute('post', '/register', { body })
    expect(res.statusCode).toBe(500)
    expect(res.body).toEqual({ success: false, error: 'Internal server error' })
  })
})

describe('POST /invite/accept — recovery conflict from the durable write surfaces as retryable 409', () => {
  function scriptUpToWrites(): void {
    inviteTokenMocks.verifyInviteToken.mockReturnValue({
      type: 'invite',
      userId: 'user-1',
      email: 'alpha@example.com',
      presetId: 'attendance-employee',
      iat: Math.floor(Date.now() / 1000) - 60,
    })
    // getInviteTarget
    pgMocks.query.mockResolvedValueOnce({
      rows: [{
        id: 'user-1',
        email: 'alpha@example.com',
        name: 'Alpha',
        is_active: true,
        activation_status: 'activated',
        updated_at: '2026-03-13T00:00:00.000Z',
      }],
    })
    bcryptMocks.hash.mockResolvedValue('password-hash')
  }

  it('[recovery-census:auth:invite-accept] marker 40001 in the invite-accept transaction → exact uniform retryable 409', async () => {
    scriptUpToWrites()
    // The REAL applyInviteAcceptanceWrites runs; its transaction raises the marker —
    // exercising service translate → route sendIfRecoveryConflict end to end.
    pgMocks.transaction.mockRejectedValue(markerError())
    const res = await invokeRoute('post', '/invite/accept', {
      body: { token: 'invite-token', password: 'Str0ng!Passw0rd' },
    })
    expect(res.statusCode).toBe(409)
    expect(res.body).toEqual(UNIFORM_409_BODY)
    expect(sessionMocks.revokeUserSessions).not.toHaveBeenCalled()
  })

  it('a non-conflict write failure keeps the ORIGINAL 500 body, exactly', async () => {
    scriptUpToWrites()
    pgMocks.transaction.mockRejectedValue(new Error('disk on fire'))
    const res = await invokeRoute('post', '/invite/accept', {
      body: { token: 'invite-token', password: 'Str0ng!Passw0rd' },
    })
    expect(res.statusCode).toBe(500)
    expect(res.body).toEqual({ success: false, error: 'Internal server error' })
  })

  it('the coded INVITE_LEDGER_CONSUME_FAILED 409 mapping is untouched', async () => {
    scriptUpToWrites()
    pgMocks.transaction.mockRejectedValue(
      Object.assign(new Error('Invite ledger could not be consumed'), {
        code: 'INVITE_LEDGER_CONSUME_FAILED',
      }),
    )
    const res = await invokeRoute('post', '/invite/accept', {
      body: { token: 'invite-token', password: 'Str0ng!Passw0rd' },
    })
    expect(res.statusCode).toBe(409)
    expect(res.body).toEqual({
      success: false,
      error: 'Invite token is missing, revoked, or already consumed',
      code: 'INVITE_LEDGER_CONSUME_FAILED',
    })
  })
})

// O2-A1 (census reachability): one discriminating behaviour leg PER remaining
// recovery-conflict call site in routes/auth.ts.
describe('remaining routes/auth.ts recovery-conflict call sites', () => {
  const namedConflict = () => new RecoveryConflictError(markerError())
  const AUTH_HEADERS = { authorization: 'Bearer session-token' }

  function scriptAuthenticatedUser(): void {
    authServiceMocks.verifyToken.mockResolvedValue({
      id: 'user-1',
      email: 'alpha@example.com',
      name: 'Alpha',
      role: 'user',
      permissions: [],
    })
  }

  function runtimeStatus(): Record<string, unknown> {
    return {
      available: true,
      requireGrant: false,
      autoLinkEmail: false,
      autoProvision: false,
      corpId: 'corp-1',
    }
  }

  describe('POST /dingtalk/unbind', () => {
    function scriptUnbind(): void {
      scriptAuthenticatedUser()
      dingtalkOauthMocks.getDingTalkRuntimeStatus.mockReturnValue(runtimeStatus())
      // The access snapshot's three reads: grant / identity / linked-count — all empty,
      // so the self-managed unbind proceeds to the service write.
      pgMocks.query.mockResolvedValue({ rows: [] })
    }

    it('[recovery-census:auth:dingtalk-unbind] named conflict from the unbind write → exact uniform retryable 409', async () => {
      scriptUnbind()
      dingtalkOauthMocks.unbindSelfManagedDingTalkIdentity.mockRejectedValue(namedConflict())
      const res = await invokeRoute('post', '/dingtalk/unbind', { headers: AUTH_HEADERS })
      expect(res.statusCode).toBe(409)
      expect(res.body).toEqual(UNIFORM_409_BODY)
    })

    it('non-conflict failure keeps the ORIGINAL fail-closed 500, exactly', async () => {
      scriptUnbind()
      dingtalkOauthMocks.unbindSelfManagedDingTalkIdentity.mockRejectedValue(new Error('driver text'))
      const res = await invokeRoute('post', '/dingtalk/unbind', { headers: AUTH_HEADERS })
      expect(res.statusCode).toBe(500)
      expect(res.body).toEqual({
        success: false,
        error: 'Failed to unbind DingTalk identity',
      })
    })
  })

  describe('POST /dingtalk/callback', () => {
    function scriptBindIntent(): void {
      scriptAuthenticatedUser()
      dingtalkOauthMocks.validateState.mockResolvedValue({
        valid: true,
        intent: 'bind',
        bindUserId: 'user-1',
        redirectPath: null,
      })
      dingtalkOauthMocks.isDingTalkConfigured.mockReturnValue(true)
      dingtalkOauthMocks.getDingTalkRuntimeStatus.mockReturnValue(runtimeStatus())
      // Pre-snapshot: not directory-managed.
      pgMocks.query.mockResolvedValue({ rows: [] })
      dingtalkOauthMocks.exchangeCodeForDingTalkProfile.mockResolvedValue({
        openId: 'open-1',
        unionId: 'union-1',
        nick: 'Alpha',
        email: null,
        mobile: null,
      })
    }

    it('[recovery-census:auth:dingtalk-callback] bind intent: named conflict from the bind write → exact uniform retryable 409', async () => {
      scriptBindIntent()
      dingtalkOauthMocks.bindDingTalkIdentityToUser.mockRejectedValue(namedConflict())
      const res = await invokeRoute('post', '/dingtalk/callback', {
        headers: AUTH_HEADERS,
        body: { code: 'auth-code', state: 'state-1' },
      })
      expect(res.statusCode).toBe(409)
      expect(res.body).toEqual(UNIFORM_409_BODY)
    })

    function scriptActivateIntent(): void {
      dingtalkOauthMocks.validateState.mockResolvedValue({
        valid: true,
        intent: 'activate',
        activateUserId: 'user-9',
        activateAdminUserId: 'admin-1',
        redirectPath: null,
      })
      dingtalkOauthMocks.isDingTalkConfigured.mockReturnValue(true)
      dingtalkOauthMocks.getDingTalkRuntimeStatus.mockReturnValue(runtimeStatus())
      dingtalkOauthMocks.exchangeCodeForDingTalkProfile.mockResolvedValue({
        openId: 'open-1',
        unionId: 'union-1',
        nick: 'Pending User',
        email: null,
        mobile: null,
      })
      rbacMocks.isAdmin.mockResolvedValue(true)
      pgMocks.query.mockImplementation(async (sql: unknown) => {
        const text = String(sql)
        // isActivePlatformAdmin's users read.
        if (text.includes('FROM users')) {
          return { rows: [{ is_active: true, activation_status: 'activated' }] }
        }
        // resolveDingTalkActivationSource: exactly one eligible directory account.
        if (text.includes('FROM directory_accounts')) {
          return { rows: [{ directory_account_id: 'da-1' }] }
        }
        return { rows: [] }
      })
    }

    it('[recovery-census:auth:dingtalk-callback-activate-passthrough] activate intent: the named conflict from activatePendingUser must NOT collapse into the activate_failed 500 — exact uniform retryable 409', async () => {
      scriptActivateIntent()
      userActivateMocks.activatePendingUser.mockRejectedValue(namedConflict())
      const res = await invokeRoute('post', '/dingtalk/callback', {
        body: { code: 'auth-code', state: 'state-1' },
      })
      expect(res.statusCode).toBe(409)
      expect(res.body).toEqual(UNIFORM_409_BODY)
    })

    it('activate intent: a non-conflict activate failure keeps the ORIGINAL activate mapping (never the uniform 409)', async () => {
      scriptActivateIntent()
      userActivateMocks.activatePendingUser.mockRejectedValue(
        Object.assign(new Error('driver text, never published'), { code: 'ACTIVATE_DB_FAILURE' }),
      )
      const res = await invokeRoute('post', '/dingtalk/callback', {
        body: { code: 'auth-code', state: 'state-1' },
      })
      // mapDingTalkActivationFailure's fallback: 500 activate_failed with a fixed message.
      expect(res.statusCode).toBe(500)
      expect((res.body as { success: boolean }).success).toBe(false)
      expect((res.body as { code?: string }).code).toBe('activate_failed')
    })
  })

  describe('POST /login/dingtalk/container', () => {
    it('[recovery-census:auth:container-login] named conflict from the JIT provision → exact uniform retryable 409', async () => {
      vi.stubEnv('DINGTALK_CONTAINER_LOGIN_ENABLED', 'true')
      dingtalkOauthMocks.exchangeEnterpriseAuthCodeForUser.mockRejectedValue(namedConflict())
      const res = await invokeRoute('post', '/login/dingtalk/container', {
        body: { authCode: 'container-auth-code' },
      })
      expect(res.statusCode).toBe(409)
      expect(res.body).toEqual(UNIFORM_409_BODY)
    })

    it('non-conflict failure keeps the ORIGINAL container-login 500, exactly', async () => {
      vi.stubEnv('DINGTALK_CONTAINER_LOGIN_ENABLED', 'true')
      dingtalkOauthMocks.exchangeEnterpriseAuthCodeForUser.mockRejectedValue(new Error('driver text'))
      const res = await invokeRoute('post', '/login/dingtalk/container', {
        body: { authCode: 'container-auth-code' },
      })
      expect(res.statusCode).toBe(500)
      expect(res.body).toEqual({
        success: false,
        error: 'DingTalk authentication failed',
      })
    })
  })
})
