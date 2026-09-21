/**
 * CSV shared-sanitizer migration (owner-scoped hygiene slice, chore/csv-shared-sanitizer).
 *
 * GET /api/attendance-admin/audit-logs/export.csv used a local `csvCell` that already handled
 * RFC-4180 comma/quote/CR/LF correctly. This asserts the migrated output — `csvCell` now
 * delegates to the shared `csv-cell.ts` `sanitizeCsvCell` — on TWO axes:
 *
 *   1. Byte-for-byte parity for plain/RFC-4180-special cells — column order, header text, and
 *      the '\n' row terminator are unchanged from the pre-migration local `csvCell`.
 *   2. A positive control for the one INTENTIONAL addition the shared helper brings to this
 *      endpoint: a cell starting with a formula-injection lead character now gets a defensive
 *      leading apostrophe.
 */
import express from 'express'
import request from 'supertest'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { usePinnedServer } from '../utils/pinned-server'

const queryMock = vi.hoisted(() => vi.fn())

vi.mock('../../src/db/pg', () => ({
  query: queryMock,
}))

vi.mock('../../src/rbac/rbac', () => ({
  rbacGuard: () => (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
}))

vi.mock('../../src/rbac/service', () => ({
  isAdmin: vi.fn(async () => true),
  listUserPermissions: vi.fn(async () => []),
}))

vi.mock('../../src/routes/admin-users', () => ({
  ensurePlatformAdmin: vi.fn(async () => 'admin-1'),
}))

vi.mock('../../src/services/AttendanceNotificationRedelivery', () => ({
  redeliverFailedAttendanceNotification: vi.fn(),
}))

import { attendanceAdminRouter } from '../../src/routes/attendance-admin'

function makeApp() {
  const app = express()
  app.use((req, _res, next) => {
    req.user = { id: 'admin-1', roles: ['admin'], permissions: ['attendance:admin'] } as never
    next()
  })
  app.use(attendanceAdminRouter())
  return app
}

const pinned = usePinnedServer()

describe('GET /api/attendance-admin/audit-logs/export.csv — shared csv-cell.ts sanitizer migration', () => {
  beforeEach(() => {
    queryMock.mockReset()
    pinned.setApp(makeApp())
  })

  it('produces byte-identical output for plain and RFC-4180-special cells', async () => {
    queryMock.mockResolvedValueOnce({
      rows: [
        {
          id: 'audit-1',
          actor_id: 'actor-1',
          actor_type: 'user',
          action: 'attendance.clockIn',
          resource_type: 'attendance_record',
          resource_id: 'rec-1',
          request_id: 'req-1',
          ip: '127.0.0.1',
          user_agent: 'UA, "quoted"',
          route: '/api/attendance/clock-in',
          status_code: 200,
          latency_ms: 42,
          occurred_at: '2026-01-01T00:00:00.000Z',
          meta: { error: { code: 'E1', message: 'boom' } },
        },
      ],
    })

    const response = await request(pinned.url()).get('/api/attendance-admin/audit-logs/export.csv')

    expect(response.status).toBe(200)
    expect(response.headers['content-type']).toContain('text/csv')
    expect(response.text).toBe(
      [
        'occurredAt,id,actorId,actorType,action,route,statusCode,latencyMs,resourceType,resourceId,requestId,ip,userAgent,errorCode,errorMessage,meta',
        [
          '2026-01-01T00:00:00.000Z',
          'audit-1',
          'actor-1',
          'user',
          'attendance.clockIn',
          '/api/attendance/clock-in',
          '200',
          '42',
          'attendance_record',
          'rec-1',
          'req-1',
          '127.0.0.1',
          '"UA, ""quoted"""',
          'E1',
          'boom',
          '"{""error"":{""code"":""E1"",""message"":""boom""}}"',
        ].join(','),
      ].join('\n'),
    )
  })

  it('positive control: neutralizes a formula-injection lead character (new behavior)', async () => {
    queryMock.mockResolvedValueOnce({
      rows: [
        {
          id: 'audit-2',
          actor_id: 'actor-2',
          actor_type: 'user',
          action: '=cmd|/C calc',
          resource_type: 'attendance_record',
          resource_id: 'rec-2',
          request_id: 'req-2',
          ip: '10.0.0.1',
          user_agent: 'UA2',
          route: '/api/attendance/clock-out',
          status_code: 200,
          latency_ms: 10,
          occurred_at: '2026-01-02T00:00:00.000Z',
          meta: {},
        },
      ],
    })

    const response = await request(pinned.url()).get('/api/attendance-admin/audit-logs/export.csv')

    expect(response.status).toBe(200)
    expect(response.text).toBe(
      [
        'occurredAt,id,actorId,actorType,action,route,statusCode,latencyMs,resourceType,resourceId,requestId,ip,userAgent,errorCode,errorMessage,meta',
        [
          '2026-01-02T00:00:00.000Z',
          'audit-2',
          'actor-2',
          'user',
          "'=cmd|/C calc",
          '/api/attendance/clock-out',
          '200',
          '10',
          'attendance_record',
          'rec-2',
          'req-2',
          '10.0.0.1',
          'UA2',
          '',
          '',
          '{}',
        ].join(','),
      ].join('\n'),
    )
  })

  // P1-2 audit (csv-helper gate): `operation_audit_logs.occurred_at`/`created_at` are TIMESTAMPTZ
  // (`20250926_create_operation_audit_logs.ts`), so pg hands the route a real `Date`, not the
  // string the two cases above use for `occurred_at`. This route's `formatAuditOccurredAt`
  // (unchanged by this migration) already has an `instanceof Date` branch, so — unlike
  // `admin-users.ts` (P1-2) — there is no regression here; this fixture uses a real `new Date(...)`
  // rather than a string stand-in to pin that this endpoint's Date handling stays correct.
  it('a real Date occurred_at (pg runtime shape) renders as a clean ISO cell', async () => {
    queryMock.mockResolvedValueOnce({
      rows: [
        {
          id: 'audit-3',
          actor_id: 'actor-3',
          actor_type: 'user',
          action: 'attendance.clockIn',
          resource_type: 'attendance_record',
          resource_id: 'rec-3',
          request_id: 'req-3',
          ip: '127.0.0.1',
          user_agent: 'UA3',
          route: '/api/attendance/clock-in',
          status_code: 200,
          latency_ms: 5,
          occurred_at: new Date('2026-01-03T00:00:00.000Z'),
          meta: {},
        },
      ],
    })

    const response = await request(pinned.url()).get('/api/attendance-admin/audit-logs/export.csv')

    expect(response.status).toBe(200)
    expect(response.text).toBe(
      [
        'occurredAt,id,actorId,actorType,action,route,statusCode,latencyMs,resourceType,resourceId,requestId,ip,userAgent,errorCode,errorMessage,meta',
        [
          '2026-01-03T00:00:00.000Z',
          'audit-3',
          'actor-3',
          'user',
          'attendance.clockIn',
          '/api/attendance/clock-in',
          '200',
          '5',
          'attendance_record',
          'rec-3',
          'req-3',
          '127.0.0.1',
          'UA3',
          '',
          '',
          '{}',
        ].join(','),
      ].join('\n'),
    )
  })
})
