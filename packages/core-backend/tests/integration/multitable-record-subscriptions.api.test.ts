import express from 'express'
import request from 'supertest'
import { afterEach, describe, expect, test, vi } from 'vitest'

type QueryResult = {
  rows: any[]
  rowCount?: number
}

type QueryHandler = (sql: string, params?: unknown[]) => QueryResult | Promise<QueryResult>

function createMockPool(queryHandler: QueryHandler) {
  const query = vi.fn(async (sql: string, params?: unknown[]) => {
    if (sql.includes('FROM spreadsheet_permissions')) {
      return { rows: [], rowCount: 0 }
    }
    if (sql.includes('FROM record_permissions')) {
      return { rows: [], rowCount: 0 }
    }
    return queryHandler(sql, params)
  })
  const transaction = vi.fn(async (fn: (client: { query: typeof query }) => Promise<unknown>) => fn({ query }))
  return { query, transaction }
}

async function createApp(args: {
  tokenPerms?: string[]
  queryHandler: QueryHandler
}) {
  vi.resetModules()
  vi.doMock('../../src/rbac/service', () => ({
    isAdmin: vi.fn().mockResolvedValue(false),
    userHasPermission: vi.fn().mockResolvedValue(false),
    listUserPermissions: vi.fn().mockResolvedValue([]),
    invalidateUserPerms: vi.fn(),
    getPermCacheStatus: vi.fn(),
  }))

  const { poolManager } = await import('../../src/integration/db/connection-pool')
  const { univerMetaRouter } = await import('../../src/routes/univer-meta')
  const mockPool = createMockPool(args.queryHandler)
  vi.spyOn(poolManager, 'get').mockReturnValue(mockPool as any)

  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => {
    req.user = {
      id: 'user_multitable_1',
      roles: [],
      perms: args.tokenPerms ?? [],
    }
    next()
  })
  app.use('/api/multitable', univerMetaRouter())

  return { app, mockPool }
}

describe('Multitable record subscription routes', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.resetModules()
  })

  test('returns only the current user subscription status without enumerating watchers', async () => {
    const { app, mockPool } = await createApp({
      tokenPerms: ['multitable:read'],
      queryHandler: async (sql, params) => {
        if (sql.includes('SELECT id, sheet_id FROM meta_records WHERE id = $1 AND sheet_id = $2')) {
          expect(params).toEqual(['rec_1', 'sheet_ops'])
          return { rows: [{ id: 'rec_1', sheet_id: 'sheet_ops' }] }
        }
        if (sql.includes('FROM meta_record_subscriptions')) {
          expect(params).toEqual(['sheet_ops', 'rec_1', 'user_multitable_1'])
          return {
            rows: [{
              id: '11111111-1111-1111-1111-111111111111',
              sheet_id: 'sheet_ops',
              record_id: 'rec_1',
              user_id: 'user_multitable_1',
              created_at: '2026-05-05T00:00:00.000Z',
              updated_at: '2026-05-05T00:00:00.000Z',
            }],
          }
        }
        throw new Error(`Unhandled SQL in test: ${sql}`)
      },
    })

    const response = await request(app)
      .get('/api/multitable/sheets/sheet_ops/records/rec_1/subscriptions')
      .expect(200)

    expect(response.body.data).toMatchObject({
      subscribed: true,
      subscription: {
        sheetId: 'sheet_ops',
        recordId: 'rec_1',
        userId: 'user_multitable_1',
      },
    })
    expect(response.body.data.items).toBeUndefined()
    expect(JSON.stringify(response.body)).not.toContain('watcher_')
    expect(mockPool.query).not.toHaveBeenCalledWith(
      expect.stringContaining('ORDER BY updated_at DESC, user_id ASC'),
      expect.anything(),
    )
  })
})
