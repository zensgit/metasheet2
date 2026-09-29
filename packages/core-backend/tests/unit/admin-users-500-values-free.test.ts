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
  transportLog = vi.spyOn(winston.transports.Console.prototype, 'log' as never).mockImplementation(
    ((_info: unknown, next?: () => void) => { if (typeof next === 'function') next() }) as never,
  )
  pgMocks.query.mockReset()
  pgMocks.query.mockImplementation(routeSql)
  pgMocks.transaction.mockReset()
  pgMocks.transaction.mockImplementation(async (handler: (client: { query: typeof routeSql }) => Promise<unknown>) => {
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
