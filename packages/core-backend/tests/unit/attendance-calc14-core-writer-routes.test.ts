import express, { type NextFunction, type Request, type Response } from 'express'
import request from 'supertest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { usePinnedServer } from '../utils/pinned-server'

const mocks = vi.hoisted(() => ({
  query: vi.fn(), transaction: vi.fn(), audit: vi.fn(),
  actor: 'calc14-real-actor', platform: true,
}))
vi.mock('../../src/db/pg', () => ({ query: mocks.query, transaction: mocks.transaction }))
vi.mock('../../src/middleware/auth', () => ({
  authenticate: (req: Request, _res: Response, next: NextFunction) => {
    req.user = { id: mocks.actor, role: 'user' }
    next()
  },
}))
vi.mock('../../src/rbac/service', () => ({
  isAdmin: vi.fn(async () => mocks.platform),
  listUserPermissions: vi.fn(async () => []),
  invalidateUserPerms: vi.fn(),
}))
// Authorization middleware has separate native coverage. The real route org gate,
// target-user gate, service, posture resolver and date helper run below.
vi.mock('../../src/rbac/rbac', () => ({
  rbacGuard: () => (_req: Request, _res: Response, next: NextFunction) => next(),
}))
vi.mock('../../src/audit/audit', () => ({ auditLog: mocks.audit }))
vi.mock('bcryptjs', () => ({ hash: vi.fn(async () => 'calc14-test-hash') }))
vi.mock('../../src/auth/login-alias-service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/auth/login-alias-service')>()
  return { ...actual, claimNonEmptyLoginAliasesOrThrow: vi.fn(async () => []) }
})

import { adminUsersRouter } from '../../src/routes/admin-users'
import { attendanceAdminRouter } from '../../src/routes/attendance-admin'
import { registerAttendanceCalculationGroupTimezoneSourceGuard } from '../../src/services/AttendanceCalculationGroupMembership'

const ORG = '11111111-1111-4111-8111-111111111111'
const FOREIGN_ORG = '99999999-9999-4999-8999-999999999999'
const GROUP = '22222222-2222-4222-8222-222222222222'
const SHIFT = '33333333-3333-4333-8333-333333333333'
const USER = '44444444-4444-4444-8444-444444444444'
const MEMBER = '55555555-5555-4555-8555-555555555555'
const ADMIN_ROUTE = '/api/admin/users'
const W1_ROUTE = '/api/attendance-admin/calculation-group-memberships/transition'
const pinned = usePinnedServer()

// A transaction-bound SQL fake, not PG/runtime evidence. In particular, the
// capture receipt below only proves the actual route passes its date into the
// same client's context before source DML and flushes before commit.
const db = {
  state: 'group_shadow', authorizedOrg: ORG, groupPresent: true, targetActive: true,
  timeline: [] as Record<string, unknown>[], replay: null as Record<string, unknown> | null,
  flushFailure: null as unknown, verifyFailure: false,
  committed: [] as string[],
  receipts: [] as Array<{ org: unknown; date: unknown; actor: unknown; tables: string[] }>,
  events: [] as string[],
  contexts: [] as unknown[][],
}
function row(overrides: Record<string, unknown> = {}) {
  return {
    id: MEMBER, org_id: ORG, user_id: USER, group_id: GROUP,
    effective_from: '2026-10-31', effective_to: null,
    assigned_by: mocks.actor, assigned_reason: 'source-change',
    assigned_correlation_id: 'calc14-route-operation',
    closed_by: null, closed_reason: null, closed_correlation_id: null,
    created_at: '2026-10-30T16:30:00Z', updated_at: '2026-10-30T16:30:00Z',
    ...overrides,
  }
}
function result(rows: Record<string, unknown>[] = []) { return { rows } }

function execute(
  sql: string, params: unknown[] = [],
  tx?: { writes: string[]; context: unknown[]; flushed: boolean },
) {
  const text = sql.replace(/\s+/g, ' ').trim()
  db.events.push(text)
  if (text.includes('SELECT state, scope')) return result([{ state: db.state, scope: 'synthetic_staging' }])
  if (text.startsWith('SELECT timezone')) return result([{ timezone: 'Asia/Taipei' }])
  if (text.includes('current_setting')) return result([])
  if (text.includes("set_config('metasheet.calc14_")) {
    if (!tx) throw new Error('context-used-pool')
    tx.context = [...params]
    db.contexts.push([...params])
    return result()
  }
  if (text.startsWith('SET CONSTRAINTS') && text.endsWith('IMMEDIATE')) {
    if (!tx) throw new Error('flush-used-pool')
    if (db.flushFailure) throw db.flushFailure
    const sources = tx.writes.filter((table) => /^attendance_(group_members|shift_assignments|calculation_group_memberships)$/.test(table))
    if (sources.length && tx.context[1] === '') {
      throw { code: '23514', message: 'ATTENDANCE_CALC14_EFFECTIVE_DATE_REQUIRED' }
    }
    if (sources.length) {
      db.receipts.push({ org: tx.context[0], date: tx.context[1], actor: tx.context[2], tables: sources })
    }
    tx.flushed = true
    return result()
  }
  if (text.startsWith('INSERT INTO') || text.startsWith('UPDATE attendance_calculation_group_memberships')) {
    if (!tx) throw new Error('business-write-used-pool')
    const table = text.match(/^(?:INSERT INTO|UPDATE) ([a-z_]+)/)?.[1] ?? ''
    tx.writes.push(table)
    if (table === 'attendance_calculation_group_memberships') return result([row()])
    if (table === 'attendance_group_members') return result([{ memberId: MEMBER }])
    if (table === 'attendance_shift_assignments') return result([{ assignmentId: 'calc14-assignment' }])
    return result()
  }
  if (text.includes('FROM attendance_calculation_group_membership_operations')) return result(db.replay ? [db.replay] : [])
  if (text.includes('FROM attendance_calculation_group_memberships')) {
    return result(text.includes('WHERE org_id = $1 AND id = $2') ? [row()] : db.timeline)
  }
  if (text.includes('FROM attendance_groups')) return result(db.groupPresent ? [{ id: GROUP, name: 'Synthetic group' }] : [])
  if (text.includes('FROM attendance_shifts')) return result([{ id: SHIFT, name: 'Synthetic shift', segment_count: 0 }])
  if (text.includes('to_regclass')) return result([{ present: true }])
  if (text.includes('FROM users u') && text.includes('JOIN user_orgs')) return result(db.targetActive ? [{ allowed: 1 }] : [])
  if (text.includes('FROM user_orgs')) return result(params.includes(db.authorizedOrg) ? [{ allowed: 1 }] : [])
  if (text.includes('FROM directory_integrations')) return result([{ found: 1 }])
  if (text.includes('FROM users') && text.includes('WHERE id = $1')) {
    return result([{ id: params[0], name: 'Synthetic user', username: 'calc14route', role: 'user', is_active: true }])
  }
  return result()
}
function adminBody(extra: Record<string, unknown> = {}) {
  return {
    name: 'Synthetic user', username: 'calc14route', password: 'T3st-Only-9a!Calc14',
    orgId: ORG, attendanceGroupId: GROUP, defaultShiftId: SHIFT,
    defaultShiftStartDate: '2026-10-31', ...extra,
  }
}
function w1Body(extra: Record<string, unknown> = {}) {
  return {
    orgId: ORG, userId: USER, targetGroupId: GROUP,
    effectiveOn: '2026-10-31', reason: 'source-change',
    correlationId: 'calc14-route-operation', ...extra,
  }
}
function expectNoHistory() {
  expect(db.contexts).toEqual([])
  expect(db.receipts).toEqual([])
  expect(db.events.some((event) => event.startsWith('SET CONSTRAINTS'))).toBe(false)
}
function expectSourceOrder() {
  const context = db.events.findIndex((event) => event.includes("set_config('metasheet.calc14_"))
  const mutation = db.events.findIndex((event) => /^(INSERT INTO|UPDATE) attendance_(group_members|shift_assignments|calculation_group_memberships)\b/.test(event))
  const flush = db.events.findIndex((event) => event.startsWith('SET CONSTRAINTS') && event.endsWith('IMMEDIATE'))
  expect(context).toBeGreaterThan(-1)
  expect(mutation).toBeGreaterThan(context)
  expect(flush).toBeGreaterThan(mutation)
  expect(db.events.indexOf('COMMIT')).toBeGreaterThan(flush)
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-10-30T16:30:00Z'))
  vi.stubEnv('ATTENDANCE_W7_CONTEXT_SOURCE_ENABLED', ORG)
  mocks.platform = true
  Object.assign(db, {
    state: 'group_shadow', authorizedOrg: ORG, groupPresent: true, targetActive: true,
    timeline: [], replay: null, flushFailure: null, verifyFailure: false,
    committed: [], receipts: [], events: [], contexts: [],
  })
  mocks.query.mockImplementation(async (sql: string, params?: unknown[]) => execute(sql, params))
  mocks.transaction.mockImplementation(async (work: (client: { query: typeof mocks.query }) => Promise<unknown>) => {
    const tx = { writes: [] as string[], context: [] as unknown[], flushed: false }
    db.events.push('BEGIN')
    try {
      const value = await work({ query: vi.fn(async (sql: string, params?: unknown[]) => execute(sql, params, tx)) })
      db.committed.push(...tx.writes)
      db.events.push('COMMIT')
      return value
    } catch (error) {
      db.receipts = []
      db.events.push('ROLLBACK')
      throw error
    }
  })
  registerAttendanceCalculationGroupTimezoneSourceGuard(async () => async () => {
    db.events.push('VERIFY_TIMEZONE')
    if (db.verifyFailure) throw { status: 409, code: 'ATTENDANCE_TIMEZONE_SOURCE_UNAVAILABLE' }
  })
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => {
    req.user = { id: mocks.actor, role: 'user' }
    req.correlationId = 'calc14-route-request'
    next()
  })
  app.use(adminUsersRouter())
  app.use(attendanceAdminRouter())
  pinned.setApp(app)
})
afterEach(() => {
  registerAttendanceCalculationGroupTimezoneSourceGuard(null)
  vi.useRealTimers()
  vi.unstubAllEnvs()
})

describe('CALC14 actual core public writers', () => {
  it('admin-create consumes the explicit field for both actual onboarding INSERTs', async () => {
    const response = await request(pinned.url()).post(ADMIN_ROUTE).send(adminBody({
      businessEffectiveDate: '2026-11-02', actorId: 'spoofed-actor', today: '2020-01-01',
    }))
    expect(response.status).toBe(200)
    expect(response.body.data.attendanceOnboarding).toEqual({
      orgId: ORG, group: { id: GROUP, name: 'Synthetic group', memberCreated: true },
      defaultShift: { id: SHIFT, name: 'Synthetic shift', startDate: '2026-10-31', assignmentId: 'calc14-assignment' },
    })
    expect(db.receipts).toEqual([{
      org: ORG, date: '2026-11-02', actor: mocks.actor,
      tables: ['attendance_group_members', 'attendance_shift_assignments'],
    }])
    expectSourceOrder()
  })

  it.each([ADMIN_ROUTE, W1_ROUTE])('missing date on real source mutation rolls back %s', async (route) => {
    const response = await request(pinned.url()).post(route).send(route === ADMIN_ROUTE ? adminBody() : w1Body())
    expect(response.status).toBe(422)
    expect(response.body).toEqual({ ok: false, error: {
      code: 'ATTENDANCE_CALC14_EFFECTIVE_DATE_REQUIRED', message: 'ATTENDANCE_CALC14_EFFECTIVE_DATE_REQUIRED',
    } })
    expect(db.committed).toEqual([])
    expect(db.receipts).toEqual([])
    expect(db.events).toContain('ROLLBACK')
    expect(db.events).not.toContain('COMMIT')
    expect(mocks.audit).not.toHaveBeenCalled()
  })

  it.each([
    ['2026-02-30', 422, 'ATTENDANCE_CALC14_EFFECTIVE_DATE_INVALID'],
    ['2026-10-30', 403, 'ATTENDANCE_CALC14_HISTORICAL_AUTHORIZATION_REQUIRED'],
  ])('rejects %s before source writes on both public routes', async (date, status, code) => {
    for (const route of [ADMIN_ROUTE, W1_ROUTE]) {
      const response = await request(pinned.url()).post(route).send(
        route === ADMIN_ROUTE ? adminBody({ businessEffectiveDate: date }) : w1Body({ businessEffectiveDate: date }),
      )
      expect(response.status).toBe(status)
      expect(response.body).toEqual({ ok: false, error: { code, message: code } })
    }
    expect(db.committed).toEqual([])
    expect(db.contexts).toEqual([])
  })

  it.each([ADMIN_ROUTE, W1_ROUTE])('maps source conflict and rolls back %s', async (route) => {
    db.flushFailure = { code: '23514', message: 'ATTENDANCE_CALC14_SOURCE_DATE_CONFLICT' }
    const body = { businessEffectiveDate: '2026-10-31' }
    const response = await request(pinned.url()).post(route).send(route === ADMIN_ROUTE ? adminBody(body) : w1Body(body))
    expect(response.status).toBe(409)
    expect(response.body.error).toEqual({ code: 'ATTENDANCE_CALC14_SOURCE_DATE_CONFLICT', message: 'ATTENDANCE_CALC14_SOURCE_DATE_CONFLICT' })
    expect(db.committed).toEqual([])
    expect(db.events).toContain('ROLLBACK')
  })

  it.each([ADMIN_ROUTE, W1_ROUTE])('OFF ignores the new date and preserves original response surface on %s', async (route) => {
    db.state = 'off'
    const extra = { businessEffectiveDate: 'invalid-ignored' }
    const response = await request(pinned.url()).post(route).send(route === ADMIN_ROUTE ? adminBody(extra) : w1Body(extra))
    expect(response.status).toBe(200)
    expect(response.body.ok).toBe(true)
    expect(response.body.data).not.toHaveProperty('businessEffectiveDate')
    expectNoHistory()
    expect(db.committed).toContain(route === ADMIN_ROUTE ? 'users' : 'attendance_calculation_group_memberships')
  })

  it('admin-create without attendance source input ignores date even in active W7', async () => {
    const response = await request(pinned.url()).post(ADMIN_ROUTE).send(adminBody({
      attendanceGroupId: undefined, defaultShiftId: undefined, attendanceOrgId: ORG,
      businessEffectiveDate: 'invalid-unused',
    }))
    expect(response.status).toBe(200)
    expect(response.body.data.attendanceOnboarding).toEqual({ orgId: ORG, group: null, defaultShift: null })
    expect(db.committed).toEqual(['users', 'user_orgs'])
    expectNoHistory()
    expect(db.events.some((event) => event.includes('SELECT state, scope'))).toBe(false)
  })

  it('business date cannot expand admin-create permission', async () => {
    mocks.platform = false
    const response = await request(pinned.url()).post(ADMIN_ROUTE).send(adminBody({ businessEffectiveDate: '2026-10-31' }))
    expect(response.status).toBe(403)
    expect(response.body.error.code).toBe('FORBIDDEN')
    expect(mocks.transaction).not.toHaveBeenCalled()
    expectNoHistory()
  })

  it('admin-create keeps foreign group rejection before any transaction', async () => {
    db.groupPresent = false
    const response = await request(pinned.url()).post(ADMIN_ROUTE).send(adminBody({
      orgId: FOREIGN_ORG, businessEffectiveDate: '2026-10-31',
    }))
    expect(response.status).toBe(404)
    expect(response.body.error.code).toBe('ATTENDANCE_GROUP_NOT_FOUND')
    expect(mocks.transaction).not.toHaveBeenCalled()
    expectNoHistory()
  })

  it('W1 rejects foreign org before service or context', async () => {
    mocks.platform = false
    const response = await request(pinned.url()).post(W1_ROUTE).send(w1Body({
      orgId: FOREIGN_ORG, businessEffectiveDate: '2026-10-31',
    }))
    expect(response.status).toBe(403)
    expect(response.body.error.code).toBe('FORBIDDEN')
    expect(mocks.transaction).not.toHaveBeenCalled()
    expectNoHistory()
  })

  it('W1 keeps the active target-user/org requirement', async () => {
    db.targetActive = false
    const response = await request(pinned.url()).post(W1_ROUTE).send(w1Body({ businessEffectiveDate: '2026-10-31' }))
    expect(response.status).toBe(422)
    expect(response.body.error.code).toBe('ACTIVE_ORG_USER_REQUIRED')
    expect(db.committed).toEqual([])
    expectNoHistory()
  })

  it('W1 consumes its distinct date and flushes before timezone verification', async () => {
    const response = await request(pinned.url()).post(W1_ROUTE).send(w1Body({
      businessEffectiveDate: '2026-11-01', actorId: 'spoofed-actor',
    }))
    expect(response.status).toBe(200)
    expect(response.body.data).toEqual({
      correlationId: 'calc14-route-operation', outcome: 'transitioned',
      membership: {
        id: MEMBER, orgId: ORG, userId: USER, groupId: GROUP,
        effectiveFrom: '2026-10-31', effectiveTo: null,
        assignedBy: mocks.actor, assignedReason: 'source-change', assignedCorrelationId: 'calc14-route-operation',
        closedBy: null, closedReason: null, closedCorrelationId: null,
        createdAt: '2026-10-30T16:30:00Z', updatedAt: '2026-10-30T16:30:00Z',
      },
    })
    expect(db.receipts).toEqual([{
      org: ORG, date: '2026-11-01', actor: mocks.actor, tables: ['attendance_calculation_group_memberships'],
    }])
    expectSourceOrder()
    expect(db.events.indexOf('VERIFY_TIMEZONE')).toBeGreaterThan(
      db.events.findIndex((event) => event.startsWith('SET CONSTRAINTS') && event.endsWith('IMMEDIATE')),
    )
  })

  it('W1 binds the closing UPDATE and replacement INSERT to one final-state flush', async () => {
    db.timeline = [row({
      group_id: '66666666-6666-4666-8666-666666666666', effective_from: '2026-01-01',
    })]
    const response = await request(pinned.url()).post(W1_ROUTE).send(w1Body({ businessEffectiveDate: '2026-10-31' }))
    expect(response.status).toBe(200)
    expect(response.body.data.outcome).toBe('transitioned')
    expect(db.contexts).toEqual([[ORG, '2026-10-31', mocks.actor]])
    expect(db.receipts).toEqual([{
      org: ORG, date: '2026-10-31', actor: mocks.actor,
      tables: ['attendance_calculation_group_memberships', 'attendance_calculation_group_memberships'],
    }])
    expectSourceOrder()
    expect(db.events.filter((event) => event.startsWith('SET CONSTRAINTS') && event.endsWith('IMMEDIATE'))).toHaveLength(1)
  })

  it('a late timezone guard failure rolls back membership, operation and source capture together', async () => {
    db.verifyFailure = true
    const response = await request(pinned.url()).post(W1_ROUTE).send(w1Body({ businessEffectiveDate: '2026-10-31' }))
    expect(response.status).toBe(409)
    expect(response.body.error.code).toBe('ATTENDANCE_TIMEZONE_SOURCE_UNAVAILABLE')
    expect(db.committed).toEqual([])
    expect(db.receipts).toEqual([])
    expect(db.events).toContain('ROLLBACK')
  })

  it('W1 same-group unchanged needs no date and creates no source version', async () => {
    db.timeline = [row()]
    const response = await request(pinned.url()).post(W1_ROUTE).send(w1Body())
    expect(response.status).toBe(200)
    expect(response.body.data.outcome).toBe('unchanged')
    expect(db.committed).toEqual(['attendance_calculation_group_membership_operations'])
    expectNoHistory()
  })

  it('W1 completed replay stays independent of mutable posture and date inputs', async () => {
    const snapshot = {
      id: MEMBER, orgId: ORG, userId: USER, groupId: GROUP,
      effectiveFrom: '2026-10-31', effectiveTo: null,
      assignedBy: mocks.actor, assignedReason: 'source-change', assignedCorrelationId: 'calc14-route-operation',
      closedBy: null, closedReason: null, closedCorrelationId: null,
      createdAt: '2026-10-30T16:30:00Z', updatedAt: '2026-10-30T16:30:00Z',
    }
    db.replay = {
      org_id: ORG, correlation_id: 'calc14-route-operation', user_id: USER, target_group_id: GROUP,
      effective_on: '2026-10-31', actor_id: mocks.actor, reason: 'source-change',
      result_membership_id: MEMBER, result_snapshot: snapshot, outcome: 'transitioned',
    }
    db.state = 'corrupt-posture-not-read'
    const response = await request(pinned.url()).post(W1_ROUTE).send(w1Body({ businessEffectiveDate: 'invalid-unused' }))
    expect(response.status).toBe(200)
    expect(response.body.data).toEqual({ correlationId: 'calc14-route-operation', outcome: 'transitioned', membership: snapshot })
    expect(db.committed).toEqual([])
    expectNoHistory()
    expect(db.events.some((event) => event.includes('SELECT state, scope'))).toBe(false)
  })
})
