/**
 * POST /api/approvals/:id/remind — route-level unit coverage (no database).
 *
 *  - 访问校验与详情 / 历史接口保持一致。
 *  - 催办时在同一事务里给当前节点的用户席位（不含催办人）写站内通知；角色席位只计数。
 *  - 频率限制命中时不写催办记录，也不写通知。
 *
 * The real-DB behaviour (rows actually landing) is covered by
 * tests/integration/approval-wp3-remind.api.test.ts.
 */
import express from 'express'
import request from 'supertest'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { usePinnedServer } from '../utils/pinned-server'

const authState = vi.hoisted(() => ({
  user: null as Record<string, unknown> | null,
}))

const pgState = vi.hoisted(() => ({
  client: {
    query: vi.fn(),
    release: vi.fn(),
  },
  pool: {
    query: vi.fn(),
    connect: vi.fn(),
  },
}))

const readabilityState = vi.hoisted(() => ({
  canRead: vi.fn(),
}))

vi.mock('../../src/db/pg', () => ({
  pool: pgState.pool,
  query: pgState.pool.query,
}))

vi.mock('../../src/middleware/auth', () => ({
  authenticate: (req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (!authState.user) {
      res.status(401).json({ error: 'Unauthorized' })
      return
    }
    req.user = authState.user as never
    next()
  },
}))

vi.mock('../../src/rbac/service', () => ({
  userHasPermission: vi.fn().mockResolvedValue(false),
  isAdmin: vi.fn().mockResolvedValue(false),
  listUserPermissions: vi.fn().mockResolvedValue([]),
  invalidateUserPerms: vi.fn(),
  getPermCacheStatus: vi.fn().mockReturnValue({ size: 0 }),
}))

vi.mock('../../src/rbac/namespace-admission', () => ({
  isPermissionAllowedByNamespaceAdmission: vi.fn().mockResolvedValue(true),
  filterPermissionCodesByNamespaceAdmission: vi.fn().mockImplementation(
    (_userId: string, codes: string[]) => Promise.resolve(codes),
  ),
}))

vi.mock('../../src/services/approval-instance-readability', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/services/approval-instance-readability')>()
  return {
    ...actual,
    canReadApprovalInstance: (...args: unknown[]) => readabilityState.canRead(...args),
  }
})

type Seat = { assignment_type: 'user' | 'role'; assignee_id: string }

interface Scenario {
  instance?: {
    id: string
    status: string
    source_system: string | null
    requester_snapshot: { id?: string | null } | null
    title: string | null
    request_no: string | null
  } | null
  recentRemind?: boolean
  seats?: Seat[]
}

function normalize(sqlText: string): string {
  return sqlText.replace(/\s+/g, ' ').trim()
}

function installClient(scenario: Scenario) {
  const calls: Array<{ sql: string; params: unknown[] }> = []
  pgState.client.query.mockImplementation(async (sqlText: string, params: unknown[] = []) => {
    const sql = normalize(sqlText)
    calls.push({ sql, params })
    if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [], rowCount: 0 }
    if (sql.startsWith('SELECT id, status, source_system, requester_snapshot, title, request_no FROM approval_instances')) {
      const rows = scenario.instance ? [scenario.instance] : []
      return { rows, rowCount: rows.length }
    }
    if (sql.startsWith('SELECT occurred_at FROM approval_records')) {
      const rows = scenario.recentRemind ? [{ occurred_at: new Date('2026-10-27T00:00:00.000Z') }] : []
      return { rows, rowCount: rows.length }
    }
    if (sql.startsWith('INSERT INTO approval_records')) return { rows: [], rowCount: 1 }
    if (sql.startsWith('SELECT DISTINCT assignment_type, assignee_id FROM approval_assignments')) {
      expect(sql).toContain('is_active = TRUE')
      const rows = scenario.seats ?? []
      return { rows, rowCount: rows.length }
    }
    if (sql.startsWith('INSERT INTO meta_record_subscription_notifications')) {
      const items = JSON.parse(String(params[0])) as unknown[]
      return { rows: [], rowCount: items.length }
    }
    if (sql.startsWith('DELETE FROM approval_reads')) return { rows: [], rowCount: 0 }
    throw new Error(`Unhandled SQL in remind route test: ${sql}`)
  })
  return calls
}

function pendingInstance(overrides: Partial<NonNullable<Scenario['instance']>> = {}) {
  return {
    id: 'apv_1',
    status: 'pending',
    source_system: 'platform',
    requester_snapshot: { id: 'u-req' },
    title: '采购申请',
    request_no: 'AP-0001',
    ...overrides,
  }
}

describe('POST /api/approvals/:id/remind', () => {
  const pinned = usePinnedServer()

  beforeEach(async () => {
    vi.resetModules()
    authState.user = { id: 'u-req', name: '发起人甲', permissions: ['approvals:read'] }
    pgState.pool.query.mockReset()
    pgState.pool.query.mockResolvedValue({ rows: [], rowCount: 0 })
    pgState.pool.connect.mockReset()
    pgState.client.query.mockReset()
    pgState.client.release.mockReset()
    pgState.pool.connect.mockResolvedValue(pgState.client)
    readabilityState.canRead.mockReset()
    readabilityState.canRead.mockResolvedValue(true)

    const { approvalsRouter } = await import('../../src/routes/approvals')
    const app = express()
    app.use(express.json())
    app.use(approvalsRouter())
    pinned.setApp(app)
  })

  it('answers the same 404 as the detail route when the instance is not readable, before any transaction', async () => {
    readabilityState.canRead.mockResolvedValue(false)
    authState.user = { id: 'u-other', name: '旁人', permissions: ['approvals:read', 'approvals:act'] }
    const calls = installClient({ instance: pendingInstance() })

    const response = await request(pinned.url()).post('/api/approvals/apv_1/remind').send({})

    expect(response.status).toBe(404)
    expect(response.body.error.code).toBe('APPROVAL_NOT_FOUND')
    expect(readabilityState.canRead).toHaveBeenCalledWith(pgState.pool, 'u-other', 'apv_1')
    expect(pgState.pool.connect).not.toHaveBeenCalled()
    expect(calls).toHaveLength(0)
  })

  it('does not run the readability check for a plm: id (same as the detail route)', async () => {
    installClient({ instance: pendingInstance({ id: 'plm:eco-1', source_system: 'plm' }), seats: [] })

    const response = await request(pinned.url()).post('/api/approvals/plm:eco-1/remind').send({})

    expect(response.status).toBe(200)
    expect(readabilityState.canRead).not.toHaveBeenCalled()
    expect(response.body.data.notifiedUserCount).toBe(0)
  })

  it('writes one in-app notification per active user seat except the actor, inside the transaction; role seats are only counted', async () => {
    const calls = installClient({
      instance: pendingInstance(),
      seats: [
        { assignment_type: 'user', assignee_id: 'u-a' },
        { assignment_type: 'user', assignee_id: 'u-b' },
        { assignment_type: 'user', assignee_id: 'u-req' },
        { assignment_type: 'role', assignee_id: 'role-finance' },
      ],
    })

    const response = await request(pinned.url()).post('/api/approvals/apv_1/remind').send({})

    expect(response.status).toBe(200)
    expect(response.body.data).toMatchObject({
      id: 'apv_1',
      action: 'remind',
      notifiedUserCount: 2,
      skippedRoleSeatCount: 1,
    })

    const sqls = calls.map((call) => call.sql)
    const insertIndex = sqls.findIndex((sql) => sql.startsWith('INSERT INTO meta_record_subscription_notifications'))
    const commitIndex = sqls.indexOf('COMMIT')
    expect(insertIndex).toBeGreaterThan(-1)
    expect(insertIndex).toBeLessThan(commitIndex)

    const items = JSON.parse(String(calls[insertIndex].params[0])) as Array<Record<string, unknown>>
    expect(items.map((item) => item.user_id).sort()).toEqual(['u-a', 'u-b'])
    for (const item of items) {
      expect(item.sheet_id).toBe('')
      expect(item.record_id).toBe('')
      expect(item.event_type).toBe('notification.sent')
      expect(item.actor_id).toBe('u-req')
      const message = String(item.message)
      expect(message).toBe('【催办】发起人甲 提醒你处理审批「采购申请」（编号 AP-0001）\n/approvals/apv_1')
    }
  })

  it('never puts the email or the id into the text when the token carries no name', async () => {
    authState.user = { id: 'u-req', email: 'someone@example.invalid', permissions: ['approvals:read'] }
    const calls = installClient({
      instance: pendingInstance(),
      seats: [{ assignment_type: 'user', assignee_id: 'u-a' }],
    })

    const response = await request(pinned.url()).post('/api/approvals/apv_1/remind').send({})

    expect(response.status).toBe(200)
    const insert = calls.find((call) => call.sql.startsWith('INSERT INTO meta_record_subscription_notifications'))!
    const [item] = JSON.parse(String(insert.params[0])) as Array<{ message: string }>
    expect(item.message.startsWith('【催办】发起人 提醒你处理审批')).toBe(true)
    expect(item.message).not.toContain('example.invalid')
    expect(item.message.split('\n')[0]).not.toContain('u-req')
  })

  it('writes no notification when only role seats are active', async () => {
    const calls = installClient({
      instance: pendingInstance(),
      seats: [{ assignment_type: 'role', assignee_id: 'role-finance' }],
    })

    const response = await request(pinned.url()).post('/api/approvals/apv_1/remind').send({})

    expect(response.status).toBe(200)
    expect(response.body.data.notifiedUserCount).toBe(0)
    expect(response.body.data.skippedRoleSeatCount).toBe(1)
    expect(calls.some((call) => call.sql.startsWith('INSERT INTO meta_record_subscription_notifications'))).toBe(false)
  })

  it('keeps the existing hourly limit: a throttled remind writes neither the record nor a notification', async () => {
    const calls = installClient({
      instance: pendingInstance(),
      recentRemind: true,
      seats: [{ assignment_type: 'user', assignee_id: 'u-a' }],
    })

    const response = await request(pinned.url()).post('/api/approvals/apv_1/remind').send({})

    expect(response.status).toBe(429)
    expect(response.body.error.code).toBe('APPROVAL_REMIND_THROTTLED')
    expect(calls.some((call) => call.sql.startsWith('INSERT INTO approval_records'))).toBe(false)
    expect(calls.some((call) => call.sql.startsWith('INSERT INTO meta_record_subscription_notifications'))).toBe(false)
  })

  it('rolls the remind back when the notification write fails', async () => {
    const calls = installClient({
      instance: pendingInstance(),
      seats: [{ assignment_type: 'user', assignee_id: 'u-a' }],
    })
    const base = pgState.client.query.getMockImplementation()!
    pgState.client.query.mockImplementation(async (sqlText: string, params: unknown[] = []) => {
      if (normalize(sqlText).startsWith('INSERT INTO meta_record_subscription_notifications')) {
        calls.push({ sql: normalize(sqlText), params })
        throw new Error('notification insert failed')
      }
      return base(sqlText, params)
    })

    const response = await request(pinned.url()).post('/api/approvals/apv_1/remind').send({})

    expect(response.status).toBe(500)
    const sqls = calls.map((call) => call.sql)
    expect(sqls).toContain('ROLLBACK')
    expect(sqls).not.toContain('COMMIT')
  })

  it('still answers 403 for a readable participant who is neither the requester nor holds approvals:act', async () => {
    authState.user = { id: 'u-a', name: '处理人', permissions: ['approvals:read'] }
    const calls = installClient({ instance: pendingInstance() })

    const response = await request(pinned.url()).post('/api/approvals/apv_1/remind').send({})

    expect(response.status).toBe(403)
    expect(response.body.error.code).toBe('APPROVAL_REMIND_FORBIDDEN')
    expect(calls.some((call) => call.sql.startsWith('INSERT'))).toBe(false)
  })
})
