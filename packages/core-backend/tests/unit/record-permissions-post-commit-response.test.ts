/**
 * FWB-0 Layer 2 — record_permissions PUT/DELETE must emit HTTP only after
 * pool.transaction resolves (post-COMMIT).
 *
 * Regression: writing res.status/res.json inside the transaction callback can
 * send 200 before COMMIT; a later commit failure then leaves success already
 * written (headersSent) while persistence rolls back.
 *
 * Seam: mock pool.transaction mirrors ConnectionPool (handler → COMMIT), with
 * an optional COMMIT throw. Success body may only appear after the transaction
 * promise settles; commit failure never emits ok:true.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { usePinnedServer } from '../utils/pinned-server'

type QueryResult = { rows: unknown[]; rowCount?: number }

type TxTimeline = {
  handlerReturned: boolean
  commitAttempted: boolean
  transactionSettled: boolean
  successJsonWhileOpen: boolean
}

function createSqlHandler(opts: { dbAdmin: boolean }): (sql: string, params?: unknown[]) => QueryResult {
  return (sql: string, params: unknown[] = []): QueryResult => {
    const q = sql.replace(/\s+/g, ' ').trim()

    // Optional-table SAVEPOINT wrappers (row-auth / actor groups soft paths)
    if (
      q.startsWith('SAVEPOINT')
      || q.startsWith('ROLLBACK TO SAVEPOINT')
      || q.startsWith('RELEASE SAVEPOINT')
    ) {
      return { rows: [] }
    }

    // Shared sheet + actor + sheet-grant authority locks precede the row-auth advisory.
    if (q.includes('SELECT id FROM meta_sheets') && q.includes('FOR SHARE')) {
      return { rows: [{ id: params[0] }] }
    }
    if (q.includes('SELECT role_id FROM user_roles') && q.includes('FOR SHARE')) return { rows: [] }
    if (q.includes('SELECT permission_code FROM user_permissions') && q.includes('FOR SHARE')) return { rows: [] }
    if (q.includes('SELECT id FROM users') && q.includes('FOR SHARE')) return { rows: [{ id: params[0] }] }
    if (q.includes('SELECT group_id FROM platform_member_group_members') && q.includes('FOR SHARE')) return { rows: [] }
    if (q.includes('pg_advisory_xact_lock')) return { rows: [{ pg_advisory_xact_lock: '' }] }
    if (q.includes('FROM record_permissions') && q.includes('FOR UPDATE')) return { rows: [] }

    if (q.includes('SELECT 1 FROM user_roles') && q.includes("role_id = $2")) {
      return { rows: opts.dbAdmin ? [{ '?column?': 1 }] : [] }
    }
    if (q.includes('SELECT DISTINCT permission_code AS code')) return { rows: [] }
    if (q.includes('SELECT permissions FROM users')) return { rows: [{ permissions: [] }] }

    if (q.includes('FROM meta_sheets') && q.includes('base_id = $2')) return { rows: [] }
    if (q.includes('FROM meta_sheets') && q.includes('WHERE id = $1')) {
      return {
        rows: [{
          id: params[0],
          base_id: 'base-rp-1',
          name: 'Sheet',
          description: null,
        }],
      }
    }

    // resolveSheetCapabilities → loadSheetPermissionScopeMap (admin path still issues it)
    if (q.includes('FROM spreadsheet_permissions')) return { rows: [] }

    if (q.includes('FROM meta_records') && q.includes('sheet_id')) {
      return { rows: [{ id: params[0] }] }
    }
    if (q.includes('FROM users') && q.includes('WHERE id = $1')) {
      return { rows: [{ id: params[0] }] }
    }
    if (q.includes('FROM roles') && q.includes('WHERE id = $1')) {
      return { rows: [{ id: params[0] }] }
    }
    if (q.includes('FROM platform_member_groups')) {
      return { rows: [{ id: params[0] }] }
    }

    if (q.startsWith('INSERT INTO record_permissions')) {
      return { rows: [], rowCount: 1 }
    }
    if (q.startsWith('DELETE FROM record_permissions')) {
      return { rows: [], rowCount: 1 }
    }

    throw new Error(`Unhandled SQL in record-permissions post-commit test: ${q}`)
  }
}

/**
 * Faithful ConnectionPool.transaction seam: BEGIN → handler → COMMIT.
 * Commit can fail after the handler has returned its typed outcome.
 */
function createPool(opts: {
  failCommit?: boolean
  dbAdmin?: boolean
  timeline: TxTimeline
  onSuccessJson?: () => void
}) {
  const sqlHandler = createSqlHandler({ dbAdmin: opts.dbAdmin !== false })
  const query = vi.fn(async (sql: string, params?: unknown[]) => sqlHandler(sql, params))

  const transaction = vi.fn(async <T>(
    handler: (client: { query: typeof query }) => Promise<T>,
  ): Promise<T> => {
    opts.timeline.handlerReturned = false
    opts.timeline.commitAttempted = false
    opts.timeline.transactionSettled = false
    try {
      const result = await handler({ query })
      opts.timeline.handlerReturned = true
      // COMMIT phase (real pool: await rawClient.query('COMMIT'))
      opts.timeline.commitAttempted = true
      if (opts.failCommit) {
        throw new Error('simulated COMMIT failure')
      }
      return result
    } finally {
      opts.timeline.transactionSettled = true
    }
  })

  return { query, transaction }
}

async function createApp(opts: {
  failCommit?: boolean
  dbAdmin?: boolean
  timeline: TxTimeline
}) {
  vi.resetModules()
  vi.doMock('../../src/rbac/service', () => ({
    isAdmin: vi.fn().mockResolvedValue(true),
    userHasPermission: vi.fn().mockResolvedValue(true),
    listUserPermissions: vi.fn().mockResolvedValue(['multitable:read', 'multitable:write']),
    invalidateUserPerms: vi.fn(),
    getPermCacheStatus: vi.fn(),
  }))

  const { poolManager } = await import('../../src/integration/db/connection-pool')
  const { univerMetaRouter } = await import('../../src/routes/univer-meta')
  const mockPool = createPool(opts)
  vi.spyOn(poolManager, 'get').mockReturnValue(mockPool as any)

  const app = express()
  app.use(express.json())
  // Capture whether success was written before the transaction settled.
  app.use((_req, res, next) => {
    const originalJson = res.json.bind(res)
    res.json = ((body: unknown) => {
      const payload = body as { ok?: boolean } | null
      if (payload && payload.ok === true && !opts.timeline.transactionSettled) {
        opts.timeline.successJsonWhileOpen = true
      }
      return originalJson(body)
    }) as typeof res.json
    next()
  })
  app.use((req, _res, next) => {
    req.user = {
      id: 'admin-rp-actor',
      role: 'admin',
      roles: ['admin'],
      permissions: ['multitable:read', 'multitable:write'],
      perms: ['multitable:read', 'multitable:write'],
    } as Express.Request['user']
    next()
  })
  app.use('/api/multitable', univerMetaRouter())
  return { app, mockPool }
}

const pinned = usePinnedServer()

describe('record_permissions routes — post-COMMIT HTTP response', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.resetModules()
  })

  it('PUT success response is emitted only after transaction resolution (post-COMMIT)', async () => {
    const timeline: TxTimeline = {
      handlerReturned: false,
      commitAttempted: false,
      transactionSettled: false,
      successJsonWhileOpen: false,
    }
    const { app, mockPool } = await createApp({ timeline })
    pinned.setApp(app)

    const res = await request(pinned.url())
      .put('/api/multitable/sheets/sheet-rp-1/records/rec-rp-1/permissions')
      .send({ subjectType: 'user', subjectId: 'user-target', accessLevel: 'none' })

    expect(res.status).toBe(200)
    expect(res.body).toEqual({
      ok: true,
      data: {
        sheetId: 'sheet-rp-1',
        recordId: 'rec-rp-1',
        subjectType: 'user',
        subjectId: 'user-target',
        accessLevel: 'none',
      },
    })
    expect(timeline.handlerReturned).toBe(true)
    expect(timeline.commitAttempted).toBe(true)
    expect(timeline.transactionSettled).toBe(true)
    expect(timeline.successJsonWhileOpen).toBe(false)
    expect(mockPool.transaction).toHaveBeenCalledTimes(1)

    // Canonical row-auth advisory must still run inside the txn.
    const sqlCalls = mockPool.query.mock.calls.map((c) => String(c[0]).replace(/\s+/g, ' '))
    expect(sqlCalls.some((s) => s.includes('pg_advisory_xact_lock'))).toBe(true)
    expect(sqlCalls.some((s) => s.includes('FROM record_permissions') && s.includes('FOR UPDATE'))).toBe(true)
    const actorLockIndex = sqlCalls.findIndex((s) => s.includes('FROM user_roles') && s.includes('FOR SHARE'))
    const sheetGrantLockIndex = sqlCalls.findIndex((s) => s.includes('FROM spreadsheet_permissions') && s.includes('FOR SHARE'))
    const rowAuthIndex = sqlCalls.findIndex((s) => s.includes('pg_advisory_xact_lock'))
    expect(actorLockIndex).toBeGreaterThanOrEqual(0)
    expect(sheetGrantLockIndex).toBeGreaterThan(actorLockIndex)
    expect(rowAuthIndex).toBeGreaterThan(sheetGrantLockIndex)
    expect(sqlCalls.some((s) => s.includes('INSERT INTO record_permissions'))).toBe(true)
  })

  it('PUT commit failure never emits success (no ok:true / 200 after headers-safe catch)', async () => {
    const timeline: TxTimeline = {
      handlerReturned: false,
      commitAttempted: false,
      transactionSettled: false,
      successJsonWhileOpen: false,
    }
    const { app } = await createApp({ failCommit: true, timeline })
    pinned.setApp(app)

    const res = await request(pinned.url())
      .put('/api/multitable/sheets/sheet-rp-1/records/rec-rp-1/permissions')
      .send({ subjectType: 'user', subjectId: 'user-target', accessLevel: 'none' })

    expect(res.status).toBe(500)
    expect(res.body?.ok).not.toBe(true)
    expect(res.body).toMatchObject({
      ok: false,
      error: { code: 'INTERNAL_ERROR' },
    })
    expect(timeline.commitAttempted).toBe(true)
    expect(timeline.transactionSettled).toBe(true)
    expect(timeline.successJsonWhileOpen).toBe(false)
  })

  it('PUT ignores stale request admin claims when the transaction DB authority was revoked', async () => {
    const timeline: TxTimeline = {
      handlerReturned: false,
      commitAttempted: false,
      transactionSettled: false,
      successJsonWhileOpen: false,
    }
    const { app, mockPool } = await createApp({ timeline, dbAdmin: false })
    pinned.setApp(app)

    const res = await request(pinned.url())
      .put('/api/multitable/sheets/sheet-rp-1/records/rec-rp-1/permissions')
      .send({ subjectType: 'user', subjectId: 'user-target', accessLevel: 'none' })

    expect(res.status).toBe(403)
    expect(res.body).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    const sqlCalls = mockPool.query.mock.calls.map((c) => String(c[0]).replace(/\s+/g, ' '))
    expect(sqlCalls.some((s) => s.startsWith('INSERT INTO record_permissions'))).toBe(false)
  })

  it('DELETE success response is emitted only after transaction resolution (post-COMMIT)', async () => {
    const timeline: TxTimeline = {
      handlerReturned: false,
      commitAttempted: false,
      transactionSettled: false,
      successJsonWhileOpen: false,
    }
    const { app, mockPool } = await createApp({ timeline })
    pinned.setApp(app)

    const res = await request(pinned.url())
      .delete('/api/multitable/sheets/sheet-rp-1/records/rec-rp-1/permissions/perm-rp-1')

    expect(res.status).toBe(200)
    expect(res.body).toEqual({
      ok: true,
      data: { deleted: true, permissionId: 'perm-rp-1' },
    })
    expect(timeline.successJsonWhileOpen).toBe(false)
    expect(timeline.transactionSettled).toBe(true)
    expect(mockPool.transaction).toHaveBeenCalledTimes(1)

    const sqlCalls = mockPool.query.mock.calls.map((c) => String(c[0]).replace(/\s+/g, ' '))
    expect(sqlCalls.some((s) => s.includes('pg_advisory_xact_lock'))).toBe(true)
    const actorLockIndex = sqlCalls.findIndex((s) => s.includes('FROM user_roles') && s.includes('FOR SHARE'))
    const sheetGrantLockIndex = sqlCalls.findIndex((s) => s.includes('FROM spreadsheet_permissions') && s.includes('FOR SHARE'))
    const rowAuthIndex = sqlCalls.findIndex((s) => s.includes('pg_advisory_xact_lock'))
    expect(actorLockIndex).toBeGreaterThanOrEqual(0)
    expect(sheetGrantLockIndex).toBeGreaterThan(actorLockIndex)
    expect(rowAuthIndex).toBeGreaterThan(sheetGrantLockIndex)
    expect(sqlCalls.some((s) => s.startsWith('DELETE FROM record_permissions'))).toBe(true)
  })

  it('DELETE commit failure never emits success', async () => {
    const timeline: TxTimeline = {
      handlerReturned: false,
      commitAttempted: false,
      transactionSettled: false,
      successJsonWhileOpen: false,
    }
    const { app } = await createApp({ failCommit: true, timeline })
    pinned.setApp(app)

    const res = await request(pinned.url())
      .delete('/api/multitable/sheets/sheet-rp-1/records/rec-rp-1/permissions/perm-rp-1')

    expect(res.status).toBe(500)
    expect(res.body?.ok).not.toBe(true)
    expect(res.body).toMatchObject({
      ok: false,
      error: { code: 'INTERNAL_ERROR' },
    })
    expect(timeline.successJsonWhileOpen).toBe(false)
  })
})
