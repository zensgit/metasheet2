import express from 'express'
import request from 'supertest'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { usePinnedServer } from '../utils/pinned-server'

const queryMock = vi.fn()
const transactionMock = vi.fn()

vi.mock('../../src/db/pg', () => ({
  query: (...args: unknown[]) => queryMock(...args),
  transaction: (...args: unknown[]) => transactionMock(...args),
  pool: { query: (...args: unknown[]) => queryMock(...args) },
}))

vi.mock('../../src/rbac/rbac', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/rbac/rbac')>()
  return {
    ...actual,
    rbacGuard: () => (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
  }
})

vi.mock('../../src/rbac/service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/rbac/service')>()
  return {
    ...actual,
    isAdmin: vi.fn(async (userId: string) => userId === 'platform-admin'),
    listUserPermissions: vi.fn(async () => []),
  }
})

vi.mock('../../src/routes/admin-users', () => ({ ensurePlatformAdmin: vi.fn(async () => null) }))
vi.mock('../../src/services/AttendanceScheduler', () => ({ getSharedAttendanceScheduler: vi.fn(() => null) }))
vi.mock('../../src/services/AttendanceNotificationRedelivery', () => ({ redeliverFailedAttendanceNotification: vi.fn() }))
vi.mock('../../src/services/ApprovalDirectoryOrg', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/services/ApprovalDirectoryOrg')>()
  return { ...actual, MAX_MANAGER_CHAIN_LEVELS: 10 }
})

const { attendanceAdminRouter } = await import('../../src/routes/attendance-admin')
const pinned = usePinnedServer()

const OWN_RECORD_ID = '10000000-0000-4000-8000-000000000001'
const OTHER_RECORD_ID = '10000000-0000-4000-8000-000000000002'
const MISSING_RECORD_ID = '10000000-0000-4000-8000-000000000003'

function makeApp(userId: string | null) {
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => {
    ;(req as express.Request & { user?: unknown }).user = userId ? { id: userId } : undefined
    next()
  })
  app.use(attendanceAdminRouter())
  return app
}

function installSelfReadOnlyTransaction(): void {
  transactionMock.mockImplementation(async (
    handler: (client: { query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }> }) => Promise<unknown>,
  ) => handler({
    query: vi.fn(async (sql: string, params: unknown[] = []) => {
      if (/^SET TRANSACTION READ ONLY/.test(sql)) return { rows: [] }
      if (/FROM attendance_records r/.test(sql)) {
        const recordId = String(params[0])
        if (recordId === OWN_RECORD_ID) {
          return { rows: [{
            id: OWN_RECORD_ID,
            current_calculation_id: null,
            current_mode: null,
            projection_owner: 'legacy_untracked',
            visibility_state: 'active',
            visibility_reason: 'active',
          }] }
        }
        // Mutation target: deleting the subject predicate exposes OTHER_RECORD_ID as 200.
        if (recordId === OTHER_RECORD_ID && !/r\.user_id = \$3/.test(sql)) {
          return { rows: [{
            id: OTHER_RECORD_ID,
            current_calculation_id: null,
            current_mode: null,
            projection_owner: 'legacy_untracked',
            visibility_state: 'active',
            visibility_reason: 'active',
          }] }
        }
        return { rows: [] }
      }
      throw new Error(`unexpected result SQL: ${sql}`)
    }),
  }))
}

describe('W4C-4 calculation-detail dual-host authorization', () => {
  beforeEach(() => {
    queryMock.mockReset()
    transactionMock.mockReset()
  })

  it('same-org other-user 404 is byte-identical to a missing record', async () => {
    queryMock.mockResolvedValue({ rows: [{ org_id: 'org-a' }] })
    installSelfReadOnlyTransaction()
    const app = makeApp('user-a')
    pinned.setApp(app)

    const other = await request(pinned.url()).get(
      `/api/attendance/records/${OTHER_RECORD_ID}/calculation-detail?orgId=org-a`,
    )
    const missing = await request(pinned.url()).get(
      `/api/attendance/records/${MISSING_RECORD_ID}/calculation-detail?orgId=org-a`,
    )
    expect(other.status).toBe(404)
    expect(missing.status).toBe(404)
    expect(other.text).toBe(missing.text)
  })

  it('self-host positive control can read its own legacy-untracked record', async () => {
    queryMock.mockResolvedValue({ rows: [{ org_id: 'org-a' }] })
    installSelfReadOnlyTransaction()
    const app = makeApp('user-a')
    pinned.setApp(app)
    const response = await request(pinned.url()).get(
      `/api/attendance/records/${OWN_RECORD_ID}/calculation-detail?orgId=org-a`,
    )
    expect(response.status).toBe(200)
    expect(response.body.data).toEqual({
      recordId: OWN_RECORD_ID,
      calculation: null,
      segments: [],
      current: {
        projectionOwner: 'legacy_untracked',
        visibilityState: 'active',
        visibilityReason: 'active',
        posture: 'undeterminable',
      },
    })
  })

  it('cross-org delegated admin is rejected before any calculation/result SQL', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] })
    const app = makeApp('delegated-admin')
    pinned.setApp(app)
    const response = await request(pinned.url()).get(
      `/api/attendance-admin/records/${OWN_RECORD_ID}/calculation-detail?orgId=foreign-org`,
    )
    expect(response.status).toBe(403)
    expect(response.body.error.code).toBe('FORBIDDEN')
    expect(transactionMock).not.toHaveBeenCalled()
  })
})
