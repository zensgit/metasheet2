/**
 * #6163 — the 500 branches of routes/admin-users.ts answer with a fixed sentence, never with the text
 * of the error that caused them.
 *
 * The fault: a stored secret of the DingTalk directory integration had been sealed under a key that
 * was later replaced. Reading it threw Node's GCM error; GET /api/admin/users/:userId/dingtalk-access
 * and GET /api/admin/users/:userId/member-admission answered 500 with that error's message, and the
 * user management page rendered it. A database driver error on the same path would have put a host
 * or a role name there instead.
 *
 * Three branches sit on that decrypt path (work-notification-settings.ts decrypts the stored
 * appSecret while admin-users.ts builds the DingTalk snapshot):
 *   - GET  /api/admin/users/:userId/dingtalk-access     500 DINGTALK_ACCESS_FAILED
 *   - GET  /api/admin/users/:userId/member-admission    500 MEMBER_ADMISSION_FAILED
 *   - PATCH /api/admin/users/:userId/dingtalk-grant     500 DINGTALK_GRANT_UPDATE_FAILED — the snapshot
 *     read comes AFTER the grant transaction committed and the audit row was written, so this 500 can
 *     follow a saved grant; its sentence says the result could not be confirmed, not that it failed.
 *
 * Every case goes through the REAL router mounted on a pinned server (usePinnedServer +
 * request(pinned.url()), never request(app) — #4154) behind the REAL correlation-id middleware, and
 * runs the REAL work-notification-settings and encrypted-secrets code. Two kinds of failure are
 * injected at the decrypt call:
 *   - a marker error (its message, code and extra fields carry an obvious marker string);
 *   - the real thing: a value sealed under one ENCRYPTION_KEY and read under another, so Node's own
 *     GCM error is what the handler catches.
 * The body must carry the unchanged status and code, the fixed sentence and the request's
 * correlation id (the same value as the X-Correlation-ID response header), and neither the marker nor
 * the GCM text. The log is captured at winston's Console transport (the REAL Logger, so whatever it
 * merges into a line is seen): exactly one line for the failure, carrying the same correlation id,
 * and no marker in any line.
 *
 * Two more blocks: the failure helper's own guards (correlation-id shape, class-name shape, an
 * unreadable thrown value, a throwing logger), and a SWEEP that makes every SQL statement fail with
 * the marker and drives each of the 45 former echo branches of the file through the real router.
 * The structural side (no 500 in the file may carry caught-error text; exact allowlist of seven) is
 * in admin-tree-5xx-values-free.test.ts.
 *
 * Values-free fixtures: invented ids, the reserved `.invalid` TLD, literal marker strings.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import express, { type NextFunction, type Request, type Response } from 'express'
import request from 'supertest'
import winston from 'winston'
import { usePinnedServer } from '../utils/pinned-server'

const ADMIN_ID = 'admin-6163-probe'
const USER_ID = 'user-6163-probe'
const MARKER = 'MK6163'
const GCM_TEXT = 'Unsupported state or unable to authenticate data'
const FAILURE_EVENT = 'admin-users.server-failure'

const state = vi.hoisted(() => ({
  events: [] as string[],
  grantWrites: [] as unknown[][],
  storedSecret: '',
  decryptFailure: null as unknown,
  failAllSql: false,
}))

const pgMocks = vi.hoisted(() => ({
  query: vi.fn(),
  transaction: vi.fn(),
}))

const auditMocks = vi.hoisted(() => ({ auditLog: vi.fn() }))

vi.mock('../../src/middleware/auth', () => ({
  authenticate: (req: Request, _res: Response, next: NextFunction) => {
    req.user = { id: ADMIN_ID, role: 'admin' } as never
    next()
  },
}))

vi.mock('../../src/rbac/service', () => ({
  isAdmin: vi.fn(async () => true),
  listUserPermissions: vi.fn(async () => []),
  invalidateUserPerms: vi.fn(),
}))

vi.mock('../../src/db/pg', () => ({
  query: pgMocks.query,
  transaction: pgMocks.transaction,
}))

vi.mock('../../src/audit/audit', () => ({ auditLog: auditMocks.auditLog }))

vi.mock('../../src/auth/dingtalk-oauth', () => ({
  getDingTalkRuntimeStatus: () => ({
    configured: true,
    available: true,
    corpId: 'probe-corp',
    allowedCorpIds: [],
    requireGrant: true,
    autoLinkEmail: false,
    autoProvision: false,
    unavailableReason: null,
  }),
}))

vi.mock('../../src/attendance/w4c0-identity', () => ({
  acquireAttendanceCalculationRolloutLock: vi.fn(),
  parseCanonicalAttendanceRolloutOrgKeyV1: vi.fn((value: unknown) => value),
  resolveSegmentCalculationPosture: vi.fn(),
}))

// The decrypt call work-notification-settings.ts makes. Passes through to the real implementation
// unless a marker failure is armed, and records WHEN it ran (the PATCH ordering assertion needs it).
vi.mock('../../src/security/encrypted-secrets', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/security/encrypted-secrets')>()
  return {
    ...actual,
    decryptStoredSecretValue: (value: string) => {
      state.events.push('decrypt')
      if (state.decryptFailure) throw state.decryptFailure
      return actual.decryptStoredSecretValue(value)
    },
  }
})

import { encryptStoredSecretValue } from '../../src/security/encrypted-secrets'
import { correlationIdMiddleware } from '../../src/middleware/correlation'
import { adminUsersRouter } from '../../src/routes/admin-users'

const USER_ROW = {
  id: USER_ID,
  email: 'probe@example.invalid',
  username: null,
  name: 'Probe User',
  mobile: null,
  employeeNo: null,
  department: null,
  position: null,
  hireDate: null,
  role: 'user',
  is_active: true,
  is_admin: false,
  activationStatus: 'activated',
  localPasswordSet: true,
  last_login_at: null,
  created_at: '2026-09-01T00:00:00.000Z',
  updated_at: '2026-09-01T00:00:00.000Z',
}

async function routeSql(sql: string, params: unknown[] = []) {
  // Sweep mode: every statement fails with the driver-shaped marker error.
  if (state.failAllSql) throw markerError()
  const text = String(sql)
  if (/FROM directory_integrations/.test(text)) {
    return {
      rows: [{
        id: 'integration-6163-probe',
        name: 'Probe directory',
        status: 'active',
        config: { appKey: 'probe-app-key', appSecret: state.storedSecret },
        updated_at: '2026-09-01T00:00:00.000Z',
      }],
    }
  }
  if (/FROM users/.test(text) && /FOR UPDATE/.test(text)) {
    return { rows: [{ id: USER_ID, name: 'Probe User', email: null, username: null, mobile: null, activation_status: 'activated', is_active: true, access_generation: 0 }] }
  }
  if (/INSERT INTO user_external_auth_grants/.test(text)) {
    state.events.push('grant-write')
    state.grantWrites.push(params)
    return { rows: [] }
  }
  if (/UPDATE users/.test(text) && /RETURNING access_generation/.test(text)) {
    return { rows: [{ access_generation: 1 }] }
  }
  if (/FROM users\s+WHERE id = \$1/.test(text)) return { rows: [USER_ROW] }
  if (/AS linked_count/.test(text)) return { rows: [{ linked_count: 0 }] }
  return { rows: [] }
}

function markerError(): Error {
  // Driver-shaped: a message naming a host and a role, a `code` and extra fields — all carry the marker.
  const error = new Error(`${MARKER} connection to ${MARKER}.db.invalid failed for role ${MARKER}_role`)
  Object.assign(error, { code: `${MARKER}_CODE`, detail: `${MARKER} detail`, hint: `${MARKER} hint` })
  return error
}

function buildApp() {
  const app = express()
  app.use(correlationIdMiddleware)
  app.use(express.json())
  app.use(adminUsersRouter())
  return app
}

// ── log capture at the winston transport (the real Logger and its meta merge run) ──────────────
type LogInfo = Record<string | symbol, unknown>
let transportLog: ReturnType<typeof vi.spyOn>

function capturedInfos(): LogInfo[] {
  return transportLog.mock.calls.map((call) => call[0] as LogInfo)
}

function renderInfo(info: LogInfo): string {
  const formatted = info[Symbol.for('message')]
  return `${JSON.stringify(info)} ${typeof formatted === 'string' ? formatted : ''}`
}

function allLogText(): string {
  return capturedInfos().map(renderInfo).join('\n')
}

function adminUsersErrorLines(): LogInfo[] {
  return capturedInfos().filter((info) => info.context === 'AdminUsersRoutes'
    && String(info[Symbol.for('level')] ?? info.level).includes('error'))
}

async function settleLogs(): Promise<void> {
  // winston hands records to its transports through a stream pipe; give it a few turns.
  for (let index = 0; index < 5; index += 1) await new Promise((resolve) => setImmediate(resolve))
}

const pinned = usePinnedServer()

beforeEach(() => {
  state.events = []
  state.grantWrites = []
  state.decryptFailure = null
  state.failAllSql = false
  transportLog = vi.spyOn(winston.transports.Console.prototype, 'log' as never).mockImplementation(
    ((_info: unknown, next?: () => void) => { if (typeof next === 'function') next() }) as never,
  )
  pgMocks.query.mockReset()
  pgMocks.query.mockImplementation(routeSql)
  pgMocks.transaction.mockReset()
  pgMocks.transaction.mockImplementation(async (handler: (client: { query: typeof routeSql }) => Promise<unknown>) => {
    if (state.failAllSql) throw markerError()
    state.events.push('tx-begin')
    const result = await handler({ query: routeSql })
    state.events.push('tx-commit')
    return result
  })
  auditMocks.auditLog.mockReset()
  auditMocks.auditLog.mockImplementation(async (options: { resourceType: string }) => {
    state.events.push(`audit:${options.resourceType}`)
  })
  // A value sealed under key A. The marker cases fail at the (armed) decrypt call before the real
  // decrypt runs; the GCM cases switch to key B below, so the real decrypt fails as on the demo server.
  vi.stubEnv('ENCRYPTION_KEY', 'probe-6163-key-a-0000000000000000000000')
  vi.stubEnv('ENCRYPTION_SALT', 'probe-6163-salt-a')
  state.storedSecret = encryptStoredSecretValue('probe-app-secret-placeholder')
  pinned.setApp(buildApp())
})

afterEach(() => {
  transportLog.mockRestore()
  vi.unstubAllEnvs()
})

type Failure = 'marker' | 'gcm'

function armFailure(kind: Failure): void {
  if (kind === 'marker') {
    state.decryptFailure = markerError()
  } else {
    vi.stubEnv('ENCRYPTION_KEY', 'probe-6163-key-b-1111111111111111111111')
    vi.stubEnv('ENCRYPTION_SALT', 'probe-6163-salt-b')
  }
}

const DINGTALK_GRANT_SENTENCE = '钉钉扫码登录的更新结果未能确认，请刷新页面后查看当前状态'

const BRANCHES = [
  {
    label: 'GET dingtalk-access',
    send: () => request(pinned.url()).get(`/api/admin/users/${USER_ID}/dingtalk-access`),
    code: 'DINGTALK_ACCESS_FAILED',
    sentence: 'Failed to load DingTalk access',
  },
  {
    label: 'GET member-admission',
    send: () => request(pinned.url()).get(`/api/admin/users/${USER_ID}/member-admission`),
    code: 'MEMBER_ADMISSION_FAILED',
    sentence: 'Failed to load member admission snapshot',
  },
  {
    label: 'PATCH dingtalk-grant',
    send: () => request(pinned.url()).patch(`/api/admin/users/${USER_ID}/dingtalk-grant`).send({ enabled: false }),
    code: 'DINGTALK_GRANT_UPDATE_FAILED',
    sentence: DINGTALK_GRANT_SENTENCE,
  },
] as const

describe('#6163 decrypt path: the three 500 branches answer with a fixed sentence', () => {
  it('control: with a readable secret all three answer 200 and log nothing (so each failing case below is that decrypt, not a broken fixture)', async () => {
    for (const branch of BRANCHES) {
      const response = await branch.send()
      expect({ label: branch.label, status: response.status }).toEqual({ label: branch.label, status: 200 })
    }
    await settleLogs()
    expect(state.events.filter((event) => event === 'decrypt').length).toBeGreaterThanOrEqual(3)
    expect(adminUsersErrorLines()).toEqual([])
  })

  it('control: the transport capture sees what the logger writes (so an empty capture below is not a broken spy)', async () => {
    const { Logger } = await import('../../src/core/logger')
    new Logger('AdminUsersRoutes').error(`${MARKER} capture probe`)
    await settleLogs()
    expect(allLogText()).toContain(`${MARKER} capture probe`)
  })

  for (const failure of ['marker', 'gcm'] as const) {
    for (const branch of BRANCHES) {
      it(`${branch.label}, ${failure === 'marker' ? 'marker error' : 'real GCM failure (key replaced)'} -> 500 ${branch.code}, fixed sentence, correlation id; nothing of the error in body or log`, async () => {
        armFailure(failure)
        const response = await branch.send()
        await settleLogs()

        const correlationId = response.headers['x-correlation-id']
        expect(typeof correlationId).toBe('string')
        expect(correlationId.length).toBeGreaterThan(0)

        expect(response.status).toBe(500)
        expect(response.body).toEqual({
          ok: false,
          error: { code: branch.code, message: branch.sentence, correlationId },
        })
        expect(response.text).not.toContain(MARKER)
        expect(response.text).not.toContain(GCM_TEXT)
        expect(response.text).not.toContain('stack')
        // The failure really was the decrypt call.
        expect(state.events).toContain('decrypt')

        const errorLines = adminUsersErrorLines()
        expect(errorLines).toHaveLength(1)
        expect(errorLines[0].message).toBe(
          `${FAILURE_EVENT} code=${branch.code} errorClass=Error correlationId=${correlationId}`,
        )
        // The real Logger also merges the request's correlation id into the line's meta.
        expect(errorLines[0].correlation_id).toBe(correlationId)
        expect(errorLines[0]).not.toHaveProperty('error')
        expect(errorLines[0]).not.toHaveProperty('stack')
        expect(allLogText()).not.toContain(MARKER)
        expect(allLogText()).not.toContain(GCM_TEXT)
      })
    }
  }

  it('a valid X-Correlation-ID sent by the caller is the id in the header, the body and the log line', async () => {
    armFailure('gcm')
    const sent = 'probe-6163-correlation-0001'
    const response = await request(pinned.url())
      .get(`/api/admin/users/${USER_ID}/dingtalk-access`)
      .set('X-Correlation-ID', sent)
    await settleLogs()

    expect(response.status).toBe(500)
    expect(response.headers['x-correlation-id']).toBe(sent)
    expect(response.body.error.correlationId).toBe(sent)
    expect(adminUsersErrorLines().map((line) => [line.message, line.correlation_id])).toEqual([
      [`${FAILURE_EVENT} code=DINGTALK_ACCESS_FAILED errorClass=Error correlationId=${sent}`, sent],
    ])
  })

  it('an invalid X-Correlation-ID is not echoed: the body carries the id the middleware generated instead', async () => {
    armFailure('marker')
    const response = await request(pinned.url())
      .get(`/api/admin/users/${USER_ID}/member-admission`)
      .set('X-Correlation-ID', `${MARKER} not an id`)
    await settleLogs()

    expect(response.status).toBe(500)
    const generated = response.headers['x-correlation-id']
    expect(generated).toMatch(/^[A-Za-z0-9_-]{1,128}$/)
    expect(response.body.error.correlationId).toBe(generated)
    expect(response.text).not.toContain(MARKER)
    expect(allLogText()).not.toContain(MARKER)
  })

  it('PATCH dingtalk-grant: the grant and its audit row were written BEFORE the failing snapshot read, so "could not be confirmed" is the truthful sentence', async () => {
    armFailure('gcm')
    const response = await request(pinned.url()).patch(`/api/admin/users/${USER_ID}/dingtalk-grant`).send({ enabled: false })

    expect(response.status).toBe(500)
    expect(response.body.error.code).toBe('DINGTALK_GRANT_UPDATE_FAILED')
    expect(state.events).toEqual(['tx-begin', 'grant-write', 'tx-commit', 'audit:user-auth-grant', 'decrypt'])
    expect(state.grantWrites).toHaveLength(1)
    expect(state.grantWrites[0]).toEqual(['dingtalk', false, ADMIN_ID, [USER_ID]])
    expect(auditMocks.auditLog).toHaveBeenCalledTimes(1)
    expect(auditMocks.auditLog.mock.calls[0][0]).toMatchObject({
      actorId: ADMIN_ID,
      action: 'revoke',
      resourceType: 'user-auth-grant',
      resourceId: `${USER_ID}:dingtalk`,
    })
    // Neutral about the outcome: it neither claims failure nor success.
    expect(response.body.error.message).toContain('未能确认')
    expect(response.body.error.message).toContain('刷新')
    expect(response.body.error.message).not.toMatch(/失败|成功/)
  })

  it('PATCH dingtalk-grant: the missing-openId classification still answers 400 DINGTALK_OPEN_ID_REQUIRED (unchanged 4xx)', async () => {
    state.decryptFailure = new Error('User cannot enable DingTalk grant: missing DingTalk openId')
    const response = await request(pinned.url()).patch(`/api/admin/users/${USER_ID}/dingtalk-grant`).send({ enabled: false })
    await settleLogs()

    expect(response.status).toBe(400)
    expect(response.body.error.code).toBe('DINGTALK_OPEN_ID_REQUIRED')
    expect(adminUsersErrorLines()).toEqual([])
  })

  it('a thrown value that is not an Error (a bare string carrying the marker) still gets the fixed 500 and a marker-free log line', async () => {
    state.decryptFailure = `${MARKER} bare string`
    const response = await request(pinned.url()).get(`/api/admin/users/${USER_ID}/member-admission`)
    await settleLogs()

    const correlationId = response.headers['x-correlation-id']
    expect(response.status).toBe(500)
    expect(response.body).toEqual({
      ok: false,
      error: { code: 'MEMBER_ADMISSION_FAILED', message: 'Failed to load member admission snapshot', correlationId },
    })
    expect(response.text).not.toContain(MARKER)
    expect(adminUsersErrorLines().map((line) => line.message)).toEqual([
      `${FAILURE_EVENT} code=MEMBER_ADMISSION_FAILED errorClass=string correlationId=${correlationId}`,
    ])
    expect(allLogText()).not.toContain(MARKER)
  })

  it('a typed error keeps only its class name in the log; its code and fields are not written', async () => {
    class ProbeDecryptError extends Error {}
    const typed = new ProbeDecryptError(`${MARKER} text`)
    Object.assign(typed, { code: 'ERR_PROBE_6163', detail: `${MARKER} detail` })
    state.decryptFailure = typed
    const response = await request(pinned.url()).get(`/api/admin/users/${USER_ID}/dingtalk-access`)
    await settleLogs()

    expect(response.status).toBe(500)
    const correlationId = response.headers['x-correlation-id']
    expect(adminUsersErrorLines().map((line) => line.message)).toEqual([
      `${FAILURE_EVENT} code=DINGTALK_ACCESS_FAILED errorClass=ProbeDecryptError correlationId=${correlationId}`,
    ])
    expect(allLogText()).not.toContain('ERR_PROBE_6163')
    expect(allLogText()).not.toContain(MARKER)
  })
})

describe('#6163 the failure helper\'s own guards', () => {
  it('a correlation id without the middleware\'s shape is never echoed: an invalid value a later middleware put on req falls back to the request context\'s id', async () => {
    const app = express()
    app.use(correlationIdMiddleware)
    app.use((req: Request, _res: Response, next: NextFunction) => {
      req.correlationId = `${MARKER} copied from a raw header`
      next()
    })
    app.use(express.json())
    app.use(adminUsersRouter())
    pinned.setApp(app)
    armFailure('gcm')

    const response = await request(pinned.url()).get(`/api/admin/users/${USER_ID}/dingtalk-access`)
    await settleLogs()

    const headerId = response.headers['x-correlation-id']
    expect(response.status).toBe(500)
    expect(response.body.error).toEqual({ code: 'DINGTALK_ACCESS_FAILED', message: 'Failed to load DingTalk access', correlationId: headerId })
    expect(response.text).not.toContain(MARKER)
    expect(allLogText()).not.toContain(MARKER)
  })

  it('without any correlation id the body keeps exactly { code, message }', async () => {
    const app = express()
    app.use(express.json())
    app.use(adminUsersRouter())
    pinned.setApp(app)
    armFailure('marker')

    const response = await request(pinned.url()).get(`/api/admin/users/${USER_ID}/member-admission`)
    await settleLogs()

    expect(response.status).toBe(500)
    expect(response.body).toEqual({ ok: false, error: { code: 'MEMBER_ADMISSION_FAILED', message: 'Failed to load member admission snapshot' } })
    expect(adminUsersErrorLines().map((line) => line.message)).toEqual([
      `${FAILURE_EVENT} code=MEMBER_ADMISSION_FAILED errorClass=Error`,
    ])
  })

  it('a class name that is not identifier-shaped is not written to the log', async () => {
    const Oddly = class extends Error {}
    Object.defineProperty(Oddly, 'name', { value: `${MARKER} odd class name` })
    state.decryptFailure = new Oddly('odd')
    const response = await request(pinned.url()).get(`/api/admin/users/${USER_ID}/dingtalk-access`)
    await settleLogs()

    const correlationId = response.headers['x-correlation-id']
    expect(response.status).toBe(500)
    expect(adminUsersErrorLines().map((line) => line.message)).toEqual([
      `${FAILURE_EVENT} code=DINGTALK_ACCESS_FAILED errorClass=unknown correlationId=${correlationId}`,
    ])
    expect(allLogText()).not.toContain(MARKER)
  })

  it('a thrown value whose properties cannot be read still gets the fixed 500 and one log line', async () => {
    state.decryptFailure = new Proxy({}, {
      get() { throw new Error(`${MARKER} trap`) },
    })
    const response = await request(pinned.url()).get(`/api/admin/users/${USER_ID}/dingtalk-access`)
    await settleLogs()

    const correlationId = response.headers['x-correlation-id']
    expect(response.status).toBe(500)
    expect(response.body.error).toEqual({ code: 'DINGTALK_ACCESS_FAILED', message: 'Failed to load DingTalk access', correlationId })
    expect(adminUsersErrorLines().map((line) => line.message)).toEqual([
      `${FAILURE_EVENT} code=DINGTALK_ACCESS_FAILED errorClass=unreadable correlationId=${correlationId}`,
    ])
    expect(allLogText()).not.toContain(MARKER)
  })

  it('a logger that throws does not keep the fixed 500 from being sent', async () => {
    const { Logger } = await import('../../src/core/logger')
    const loggerError = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {
      throw new Error('logger unavailable')
    })
    try {
      armFailure('gcm')
      // A bounded wait: if the helper let the logger's throw escape, no response would ever come.
      const response = await request(pinned.url()).get(`/api/admin/users/${USER_ID}/member-admission`).timeout(5000)
      expect(response.status).toBe(500)
      expect(response.body.error.code).toBe('MEMBER_ADMISSION_FAILED')
      expect(response.body.error.message).toBe('Failed to load member admission snapshot')
      expect(loggerError).toHaveBeenCalled()
    } finally {
      loggerError.mockRestore()
    }
  })
})

// ── sweep: every 500 branch of admin-users.ts that a request can reach ─────────────────────────
//
// Every SQL statement (pool query and transaction) fails with the driver-shaped marker error, so each
// route's first database call throws into its own catch. The seven sites the structural guard
// allowlists (typed attendance errors, the login-alias claim with its fixed sentence, the mapped
// activation errors) are not 500 echoes and are not in this table; the 503 schema branches and the
// "User created but failed to load access snapshot" 500 already answered with fixed text.
type SweepCase = {
  method: 'get' | 'post' | 'patch'
  path: string
  body?: Record<string, unknown>
  code: string
  sentence: string
}

const U = USER_ID
const SWEEP: SweepCase[] = [
  { method: 'get', path: '/api/admin/role-delegation/summary', code: 'ROLE_DELEGATION_SUMMARY_FAILED', sentence: 'Failed to load delegated role summary' },
  { method: 'get', path: '/api/admin/role-delegation/departments', code: 'ROLE_DELEGATION_DEPARTMENT_LIST_FAILED', sentence: 'Failed to list delegation departments' },
  { method: 'get', path: '/api/admin/role-delegation/member-groups', code: 'PLATFORM_MEMBER_GROUP_LIST_FAILED', sentence: 'Failed to list platform member groups' },
  { method: 'post', path: '/api/admin/role-delegation/member-groups', body: { name: 'Probe group' }, code: 'PLATFORM_MEMBER_GROUP_CREATE_FAILED', sentence: 'Failed to create platform member group' },
  { method: 'get', path: '/api/admin/role-delegation/member-groups/group-6163', code: 'PLATFORM_MEMBER_GROUP_READ_FAILED', sentence: 'Failed to load platform member group' },
  { method: 'get', path: '/api/admin/role-delegation/scope-templates', code: 'ROLE_DELEGATION_SCOPE_TEMPLATE_LIST_FAILED', sentence: 'Failed to list scope templates' },
  { method: 'post', path: '/api/admin/role-delegation/scope-templates', body: { name: 'Probe template' }, code: 'ROLE_DELEGATION_SCOPE_TEMPLATE_CREATE_FAILED', sentence: 'Failed to create scope template' },
  { method: 'get', path: '/api/admin/role-delegation/scope-templates/tpl-6163', code: 'ROLE_DELEGATION_SCOPE_TEMPLATE_READ_FAILED', sentence: 'Failed to load scope template' },
  { method: 'post', path: '/api/admin/role-delegation/scope-templates/tpl-6163/departments/assign', body: { directoryDepartmentId: 'dept-6163' }, code: 'ROLE_DELEGATION_SCOPE_TEMPLATE_UPDATE_FAILED', sentence: 'Failed to update scope template departments' },
  { method: 'post', path: '/api/admin/role-delegation/scope-templates/tpl-6163/member-groups/assign', body: { groupId: 'group-6163' }, code: 'ROLE_DELEGATION_SCOPE_TEMPLATE_GROUP_UPDATE_FAILED', sentence: 'Failed to update scope template member groups' },
  { method: 'get', path: `/api/admin/role-delegation/users/${U}/scopes`, code: 'ROLE_DELEGATION_SCOPE_READ_FAILED', sentence: 'Failed to load delegated admin scopes' },
  { method: 'post', path: `/api/admin/role-delegation/users/${U}/scopes/assign`, body: { namespace: 'crm', directoryDepartmentId: 'dept-6163' }, code: 'ROLE_DELEGATION_SCOPE_UPDATE_FAILED', sentence: 'Failed to update delegated admin scope' },
  { method: 'post', path: `/api/admin/role-delegation/users/${U}/scope-groups/assign`, body: { namespace: 'crm', groupId: 'group-6163' }, code: 'ROLE_DELEGATION_GROUP_SCOPE_UPDATE_FAILED', sentence: 'Failed to update delegated admin member-group scope' },
  { method: 'post', path: `/api/admin/role-delegation/users/${U}/member-groups/assign`, body: { groupId: 'group-6163' }, code: 'PLATFORM_MEMBER_GROUP_MEMBER_UPDATE_FAILED', sentence: 'Failed to update platform member group membership' },
  { method: 'post', path: `/api/admin/role-delegation/users/${U}/scope-templates/apply`, body: { namespace: 'crm', templateId: 'tpl-6163' }, code: 'ROLE_DELEGATION_SCOPE_TEMPLATE_APPLY_FAILED', sentence: 'Failed to apply scope template' },
  { method: 'get', path: '/api/admin/role-delegation/users', code: 'ROLE_DELEGATION_USER_LIST_FAILED', sentence: 'Failed to list delegation users' },
  { method: 'get', path: `/api/admin/role-delegation/users/${U}/access`, code: 'ROLE_DELEGATION_ACCESS_FAILED', sentence: 'Failed to load delegated user access' },
  { method: 'patch', path: `/api/admin/role-delegation/users/${U}/namespaces/crm/admission`, body: { enabled: true }, code: 'ROLE_DELEGATION_ADMISSION_FAILED', sentence: 'Failed to update delegated namespace admission' },
  { method: 'post', path: `/api/admin/role-delegation/users/${U}/roles/assign`, body: { roleId: 'crm_user' }, code: 'ROLE_DELEGATION_UPDATE_FAILED', sentence: 'Failed to update delegated role' },
  { method: 'get', path: '/api/admin/users', code: 'USER_LIST_FAILED', sentence: 'Failed to list users' },
  { method: 'get', path: '/api/admin/invites', code: 'INVITE_LEDGER_LIST_FAILED', sentence: 'Failed to load invite ledger' },
  { method: 'post', path: '/api/admin/invites/invite-6163/revoke', code: 'INVITE_REVOKE_FAILED', sentence: 'Failed to revoke invite' },
  { method: 'post', path: '/api/admin/invites/invite-6163/resend', code: 'INVITE_RESEND_FAILED', sentence: 'Failed to resend invite' },
  { method: 'post', path: '/api/admin/users', body: { name: 'Probe Newcomer', email: 'newcomer@example.invalid', password: 'ProbePass9A!x' }, code: 'USER_CREATE_FAILED', sentence: 'Failed to create user' },
  { method: 'patch', path: `/api/admin/users/${U}/profile`, body: { name: 'Probe Renamed' }, code: 'USER_PROFILE_UPDATE_FAILED', sentence: 'Failed to update user profile' },
  { method: 'get', path: `/api/admin/users/${U}/access`, code: 'USER_ACCESS_FAILED', sentence: 'Failed to load user access' },
  { method: 'get', path: `/api/admin/users/${U}/dingtalk-access`, code: 'DINGTALK_ACCESS_FAILED', sentence: 'Failed to load DingTalk access' },
  { method: 'get', path: `/api/admin/users/${U}/member-admission`, code: 'MEMBER_ADMISSION_FAILED', sentence: 'Failed to load member admission snapshot' },
  { method: 'patch', path: `/api/admin/users/${U}/namespaces/crm/admission`, body: { enabled: true }, code: 'MEMBER_NAMESPACE_ADMISSION_FAILED', sentence: 'Failed to update namespace admission' },
  { method: 'post', path: '/api/admin/users/namespaces/crm/admission/bulk', body: { enabled: true, userIds: [U] }, code: 'MEMBER_NAMESPACE_ADMISSION_BULK_FAILED', sentence: 'Failed to update namespace admission in bulk' },
  { method: 'patch', path: `/api/admin/users/${U}/dingtalk-grant`, body: { enabled: false }, code: 'DINGTALK_GRANT_UPDATE_FAILED', sentence: DINGTALK_GRANT_SENTENCE },
  { method: 'post', path: '/api/admin/users/dingtalk-grants/bulk', body: { enabled: false, userIds: [U] }, code: 'DINGTALK_BULK_GRANT_UPDATE_FAILED', sentence: 'Failed to update DingTalk access in bulk' },
  { method: 'post', path: `/api/admin/users/${U}/roles/assign`, body: { roleId: 'crm_user' }, code: 'ROLE_ASSIGN_FAILED', sentence: 'Failed to assign role' },
  { method: 'post', path: `/api/admin/users/${U}/roles/unassign`, body: { roleId: 'crm_user' }, code: 'ROLE_UNASSIGN_FAILED', sentence: 'Failed to unassign role' },
  { method: 'patch', path: `/api/admin/users/${U}/status`, body: { isActive: false }, code: 'USER_STATUS_FAILED', sentence: 'Failed to update user status' },
  { method: 'post', path: `/api/admin/users/${U}/reset-password`, body: {}, code: 'PASSWORD_RESET_FAILED', sentence: 'Failed to reset password' },
  { method: 'post', path: `/api/admin/users/${U}/revoke-sessions`, body: {}, code: 'SESSION_REVOKE_FAILED', sentence: 'Failed to revoke user sessions' },
  { method: 'get', path: '/api/admin/roles', code: 'ROLE_LIST_FAILED', sentence: 'Failed to list roles' },
  { method: 'get', path: '/api/admin/audit-activity', code: 'ADMIN_AUDIT_LIST_FAILED', sentence: 'Failed to load admin audit activity' },
  { method: 'get', path: '/api/admin/audit-activity/export.csv', code: 'ADMIN_AUDIT_EXPORT_FAILED', sentence: 'Failed to export admin audit activity' },
  { method: 'get', path: `/api/admin/users/${U}/sessions`, code: 'SESSION_LIST_FAILED', sentence: 'Failed to load user sessions' },
  { method: 'post', path: `/api/admin/users/${U}/sessions/session-6163/revoke`, body: {}, code: 'SESSION_REVOKE_FAILED', sentence: 'Failed to revoke session' },
  { method: 'get', path: '/api/admin/session-revocations', code: 'SESSION_REVOCATION_LIST_FAILED', sentence: 'Failed to load session revocations' },
  { method: 'post', path: '/api/admin/login-aliases/backfill', code: 'ALIAS_BACKFILL_FAILED', sentence: 'Backfill failed' },
  { method: 'get', path: '/api/admin/login-aliases/cutover-status', code: 'ALIAS_CUTOVER_STATUS_FAILED', sentence: 'Status failed' },
]

describe('#6163 sweep: every reachable 500 branch of admin-users.ts answers with its fixed sentence and no marker', () => {
  it('the table covers all 45 branches that used to return the caught message', () => {
    expect(SWEEP).toHaveLength(45)
    expect(new Set(SWEEP.map((row) => `${row.method} ${row.path}`)).size).toBe(45)
  })

  for (const row of SWEEP) {
    it(`${row.method.toUpperCase()} ${row.path} -> 500 ${row.code}`, async () => {
      state.failAllSql = true
      const call = request(pinned.url())[row.method](row.path)
      const response = row.body === undefined ? await call : await call.send(row.body)
      await settleLogs()

      const correlationId = response.headers['x-correlation-id']
      expect({ status: response.status, body: response.body }).toEqual({
        status: 500,
        body: { ok: false, error: { code: row.code, message: row.sentence, correlationId } },
      })
      expect(response.text).not.toContain(MARKER)
      expect(adminUsersErrorLines().map((line) => line.message)).toEqual([
        `${FAILURE_EVENT} code=${row.code} errorClass=Error correlationId=${correlationId}`,
      ])
      expect(allLogText()).not.toContain(MARKER)
    })
  }
})
