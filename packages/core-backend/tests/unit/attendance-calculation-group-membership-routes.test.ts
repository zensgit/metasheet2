import express from 'express'
import request from 'supertest'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  queryMock,
  listMock,
  transitionMock,
  isRbacAdminMock,
} = vi.hoisted(() => ({
  queryMock: vi.fn(),
  listMock: vi.fn(),
  transitionMock: vi.fn(),
  isRbacAdminMock: vi.fn(),
}))

vi.mock('../../src/db/pg', () => ({
  query: queryMock,
}))

vi.mock('../../src/rbac/rbac', () => ({
  rbacGuard: () => (
    _req: express.Request,
    _res: express.Response,
    next: express.NextFunction,
  ) => next(),
}))

vi.mock('../../src/rbac/service', () => ({
  isAdmin: isRbacAdminMock,
  listUserPermissions: vi.fn(async () => []),
}))

vi.mock('../../src/routes/admin-users', () => ({
  ensurePlatformAdmin: vi.fn(),
}))

vi.mock('../../src/services/AttendanceNotificationRedelivery', () => ({
  redeliverFailedAttendanceNotification: vi.fn(),
}))

vi.mock('../../src/services/AttendanceCalculationGroupMembership', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../src/services/AttendanceCalculationGroupMembership')>()
  return {
    ...actual,
    listAttendanceCalculationGroupMemberships: listMock,
    transitionAttendanceCalculationGroupMembership: transitionMock,
  }
})

import {
  AttendanceCalculationGroupMembershipError,
} from '../../src/services/AttendanceCalculationGroupMembership'
import { attendanceAdminRouter } from '../../src/routes/attendance-admin'

function makeApp(userId = 'delegated-admin') {
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => {
    req.user = {
      id: userId,
      roles: ['user'],
      permissions: ['attendance:admin'],
    }
    req.correlationId = 'request-correlation'
    next()
  })
  app.use(attendanceAdminRouter())
  return app
}

describe('attendance calculation-group membership admin routes', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    isRbacAdminMock.mockResolvedValue(false)
    queryMock.mockResolvedValue({ rows: [{ allowed: 1 }] })
    listMock.mockResolvedValue([])
    transitionMock.mockResolvedValue({
      correlationId: 'request-correlation',
      outcome: 'transitioned',
      membership: { id: 'membership-1' },
    })
  })

  it('authorizes the org before reading a target timeline', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] })

    const response = await request(makeApp()).get(
      '/api/attendance-admin/calculation-group-memberships?orgId=foreign-org&userId=target-user',
    )

    expect(response.status).toBe(403)
    expect(response.body?.error?.code).toBe('FORBIDDEN')
    expect(listMock).not.toHaveBeenCalled()
    expect(
      queryMock.mock.calls.some(([statement]) =>
        String(statement).includes('attendance_calculation_group_memberships'),
      ),
    ).toBe(false)
  })

  it('lists an authorized user timeline after the active org-membership gate', async () => {
    listMock.mockResolvedValueOnce([{ id: 'membership-1' }])

    const response = await request(makeApp()).get(
      '/api/attendance-admin/calculation-group-memberships?orgId=org-a&userId=target-user',
    )

    expect(response.status).toBe(200)
    expect(response.body).toEqual({
      ok: true,
      data: { items: [{ id: 'membership-1' }] },
    })
    expect(listMock).toHaveBeenCalledWith('org-a', 'target-user')
  })

  it('takes actor identity and fallback correlation from the authenticated request', async () => {
    const response = await request(makeApp('real-actor'))
      .post('/api/attendance-admin/calculation-group-memberships/transition')
      .send({
        orgId: 'org-a',
        userId: 'target-user',
        targetGroupId: '11111111-1111-4111-8111-111111111111',
        effectiveOn: '2026-08-01',
        reason: 'Move to the night-shift policy',
        actorId: 'spoofed-actor',
      })

    expect(response.status).toBe(200)
    expect(response.headers['x-correlation-id']).toBe('request-correlation')
    expect(transitionMock).toHaveBeenCalledWith({
      orgId: 'org-a',
      userId: 'target-user',
      targetGroupId: '11111111-1111-4111-8111-111111111111',
      effectiveOn: '2026-08-01',
      actorId: 'real-actor',
      reason: 'Move to the night-shift policy',
      correlationId: 'request-correlation',
    })
  })

  it('rejects a foreign-org transition before invoking the write service', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] })

    const response = await request(makeApp())
      .post('/api/attendance-admin/calculation-group-memberships/transition')
      .send({
        orgId: 'foreign-org',
        userId: 'target-user',
        targetGroupId: '11111111-1111-4111-8111-111111111111',
        effectiveOn: '2026-08-01',
        reason: 'Move group',
        correlationId: 'transition-1',
      })

    expect(response.status).toBe(403)
    expect(response.body?.error?.code).toBe('FORBIDDEN')
    expect(transitionMock).not.toHaveBeenCalled()
  })

  it('rejects non-string request fields instead of coercing arrays into valid values', async () => {
    const response = await request(makeApp())
      .post('/api/attendance-admin/calculation-group-memberships/transition')
      .send({
        orgId: 'org-a',
        userId: 'target-user',
        targetGroupId: '11111111-1111-4111-8111-111111111111',
        effectiveOn: ['2026-08-01'],
        reason: 'Move group',
      })

    expect(response.status).toBe(400)
    expect(response.body?.error?.code).toBe('EFFECTIVE_ON_REQUIRED')
    expect(transitionMock).not.toHaveBeenCalled()
  })

  it('rejects a blank supplied correlation id instead of silently replacing it', async () => {
    const response = await request(makeApp())
      .post('/api/attendance-admin/calculation-group-memberships/transition')
      .send({
        orgId: 'org-a',
        userId: 'target-user',
        targetGroupId: '11111111-1111-4111-8111-111111111111',
        effectiveOn: '2026-08-01',
        reason: 'Move group',
        correlationId: '   ',
      })

    expect(response.status).toBe(400)
    expect(response.body?.error?.code).toBe('CORRELATION_ID_INVALID')
    expect(transitionMock).not.toHaveBeenCalled()
  })

  it('preserves typed service errors without exposing database details', async () => {
    transitionMock.mockRejectedValueOnce(
      new AttendanceCalculationGroupMembershipError(
        'CORRELATION_ID_REUSED',
        409,
        'correlationId was already used with a different transition payload',
      ),
    )

    const response = await request(makeApp())
      .post('/api/attendance-admin/calculation-group-memberships/transition')
      .send({
        orgId: 'org-a',
        userId: 'target-user',
        targetGroupId: '11111111-1111-4111-8111-111111111111',
        effectiveOn: '2026-08-01',
        reason: 'Move group',
        correlationId: 'transition-1',
      })

    expect(response.status).toBe(409)
    expect(response.body?.error?.code).toBe('CORRELATION_ID_REUSED')
    expect(response.body?.error?.message).not.toMatch(/SELECT|constraint|postgres/i)
  })
})
