/**
 * Notification Center S1 — mark-read / mark-all-read / unread-count routes.
 *
 * The security-critical property is SELF-SCOPING: every statement filters `user_id = $1` where $1 is
 * the AUTHENTICATED user (resolved server-side), and no route accepts a userId from the body — so a
 * caller can never mark or count another user's notifications. These contract tests assert the SQL is
 * self-scoped and the user param is the auth user (not a body-supplied one), plus auth + validation.
 */
import express from 'express'
import request from 'supertest'
import { afterEach, describe, expect, test, vi } from 'vitest'

type QueryResult = { rows: any[]; rowCount?: number }
type QueryHandler = (sql: string, params?: unknown[]) => QueryResult | Promise<QueryResult>

function createMockPool(queryHandler: QueryHandler) {
  const query = vi.fn(async (sql: string, params?: unknown[]) => {
    if (sql.includes('FROM spreadsheet_permissions')) return { rows: [], rowCount: 0 }
    if (sql.includes('FROM record_permissions')) return { rows: [], rowCount: 0 }
    return queryHandler(sql, params)
  })
  const transaction = vi.fn(async (fn: (c: { query: typeof query }) => Promise<unknown>) => fn({ query }))
  return { query, transaction }
}

async function createApp(args: { queryHandler: QueryHandler; userId?: string | null }) {
  vi.resetModules()
  vi.doMock('../../src/rbac/service', () => ({
    isAdmin: vi.fn().mockResolvedValue(false), userHasPermission: vi.fn().mockResolvedValue(false),
    listUserPermissions: vi.fn().mockResolvedValue([]), invalidateUserPerms: vi.fn(), getPermCacheStatus: vi.fn(),
  }))
  const { poolManager } = await import('../../src/integration/db/connection-pool')
  const { univerMetaRouter } = await import('../../src/routes/univer-meta')
  const mockPool = createMockPool(args.queryHandler)
  vi.spyOn(poolManager, 'get').mockReturnValue(mockPool as any)
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => {
    if (args.userId !== null) (req as any).user = { id: args.userId ?? 'user_a', roles: [], perms: ['multitable:read'] }
    next()
  })
  app.use('/api/multitable', univerMetaRouter())
  return { app }
}

const UNREAD = '/api/multitable/record-subscription-notifications/unread-count'
const MARK = '/api/multitable/record-subscription-notifications/mark-read'
const MARK_ALL = '/api/multitable/record-subscription-notifications/mark-all-read'

describe('Notification Center S1 — mark-read / unread-count routes', () => {
  afterEach(() => { vi.restoreAllMocks(); vi.resetModules() })

  test('unread-count COUNTs scoped to the authenticated user', async () => {
    let params: unknown[] | undefined; let sql = ''
    const { app } = await createApp({ queryHandler: async (s, p) => {
      if (s.includes('COUNT(*)') && s.includes('meta_record_subscription_notifications')) { sql = s; params = p; return { rows: [{ count: 3 }] } }
      return { rows: [] }
    } })
    const res = await request(app).get(UNREAD)
    expect(res.status).toBe(200)
    expect(res.body.data.count).toBe(3)
    expect(params).toEqual(['user_a'])
    expect(sql).toContain('read_at IS NULL') // "unread" = read_at IS NULL (mutation-proof, not just SQL-shape)
  })

  test('mark-read UPDATEs only the AUTH user rows — a userId in the body is ignored (cross-user write impossible)', async () => {
    let sql = ''; let params: unknown[] | undefined
    const { app } = await createApp({ queryHandler: async (s, p) => {
      if (s.includes('UPDATE meta_record_subscription_notifications') && s.includes('= ANY')) { sql = s; params = p; return { rows: [], rowCount: 2 } }
      return { rows: [] }
    } })
    // body carries a malicious userId — there is no userId channel, so it cannot change the scope
    const res = await request(app).post(MARK).send({ ids: ['n1', 'n2'], userId: 'victim' })
    expect(res.status).toBe(200)
    expect(res.body.data.updated).toBe(2)
    expect(sql).toContain('user_id = $1')
    expect(sql).toContain('id::text = ANY($2)') // text compare → malformed ids harmlessly miss, no uuid-cast 500
    expect(sql).toContain('read_at IS NULL') // idempotent: only flips still-unread rows (mutation-proof)
    expect(params).toEqual(['user_a', ['n1', 'n2']]) // auth user, NOT 'victim'
  })

  test('mark-all-read UPDATEs the user unread rows, self-scoped', async () => {
    let params: unknown[] | undefined; let sql = ''
    const { app } = await createApp({ queryHandler: async (s, p) => {
      if (s.includes('UPDATE meta_record_subscription_notifications') && !s.includes('= ANY')) { sql = s; params = p; return { rows: [], rowCount: 5 } }
      return { rows: [] }
    } })
    const res = await request(app).post(MARK_ALL).send({})
    expect(res.status).toBe(200)
    expect(res.body.data.updated).toBe(5)
    expect(params).toEqual(['user_a'])
    expect(sql).toContain('read_at IS NULL') // idempotent: only flips still-unread rows (mutation-proof)
  })

  test('mark-read rejects a non-array ids body (400) before any query', async () => {
    let queried = false
    const { app } = await createApp({ queryHandler: async () => { queried = true; return { rows: [] } } })
    const res = await request(app).post(MARK).send({ ids: 'nope' })
    expect(res.status).toBe(400)
    expect(queried).toBe(false)
  })

  test('all three routes 401 without an authenticated user', async () => {
    const { app } = await createApp({ userId: null, queryHandler: async () => ({ rows: [] }) })
    expect((await request(app).get(UNREAD)).status).toBe(401)
    expect((await request(app).post(MARK).send({ ids: ['n1'] })).status).toBe(401)
    expect((await request(app).post(MARK_ALL).send({})).status).toBe(401)
  })
})
