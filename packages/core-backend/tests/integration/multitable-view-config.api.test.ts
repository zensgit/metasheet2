import express from 'express'
import request from 'supertest'
import { afterEach, describe, expect, test, vi } from 'vitest'

type QueryResult = {
  rows: any[]
  rowCount?: number
}

type QueryHandler = (sql: string, params?: unknown[]) => QueryResult | Promise<QueryResult>

function createMockPool(queryHandler: QueryHandler) {
  const query = vi.fn(async (sql: string, params?: unknown[]) => queryHandler(sql, params))
  const transaction = vi.fn(async (fn: (client: { query: typeof query }) => Promise<unknown>) => fn({ query }))
  return { query, transaction }
}

async function createApp(args: {
  tokenPerms?: string[]
  queryHandler?: QueryHandler
  fallbackPermissions?: string[]
  fallbackHasPermission?: boolean
}) {
  vi.resetModules()
  vi.doMock('../../src/rbac/service', () => ({
    isAdmin: vi.fn().mockResolvedValue(false),
    userHasPermission: vi.fn().mockImplementation(async (_userId: string, code: string) => {
      if (code === 'multitable:read' || code === 'multitable:write') {
        return args.fallbackHasPermission === true
      }
      return false
    }),
    listUserPermissions: vi.fn().mockResolvedValue(args.fallbackPermissions ?? []),
    invalidateUserPerms: vi.fn(),
    getPermCacheStatus: vi.fn(),
  }))

  const { poolManager } = await import('../../src/integration/db/connection-pool')
  const { univerMetaRouter } = await import('../../src/routes/univer-meta')
  const mockPool = createMockPool(args.queryHandler ?? (() => ({ rows: [], rowCount: 0 })))
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

describe('Multitable view config API', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.resetModules()
  })

  test('creates a view with persisted config payload', async () => {
    let insertParams: unknown[] | undefined

    const { app } = await createApp({
      tokenPerms: ['multitable:write'],
      queryHandler: async (sql, params) => {
        if (sql.includes('SELECT id FROM meta_sheets WHERE id = $1')) {
          expect(params).toEqual(['sheet_ops'])
          return { rows: [{ id: 'sheet_ops' }] }
        }
        if (sql.includes('INSERT INTO meta_views')) {
          insertParams = params
          return { rows: [], rowCount: 1 }
        }
        if (sql.includes('FROM meta_views') && sql.includes('WHERE id = $1')) {
          expect(params?.[0]).toBeDefined()
          return {
            rows: [{
              id: params?.[0],
              sheet_id: 'sheet_ops',
              name: 'Gallery',
              type: 'gallery',
              filter_info: {},
              sort_info: {},
              group_info: {},
              hidden_field_ids: [],
              config: {
                titleFieldId: 'fld_title',
                columns: 4,
                cardSize: 'large',
              },
            }],
            rowCount: 1,
          }
        }
        throw new Error(`Unhandled SQL in test: ${sql}`)
      },
    })

    const response = await request(app)
      .post('/api/multitable/views')
      .send({
        sheetId: 'sheet_ops',
        name: 'Gallery',
        type: 'gallery',
        config: {
          titleFieldId: 'fld_title',
          columns: 4,
          cardSize: 'large',
        },
      })
      .expect(201)

    expect(response.body.ok).toBe(true)
    expect(response.body.data.view).toMatchObject({
      sheetId: 'sheet_ops',
      name: 'Gallery',
      type: 'gallery',
      config: {
        titleFieldId: 'fld_title',
        columns: 4,
        cardSize: 'large',
      },
    })
    expect(insertParams?.[1]).toBe('sheet_ops')
    expect(insertParams?.[2]).toBe('Gallery')
    expect(insertParams?.[3]).toBe('gallery')
    expect(insertParams?.[8]).toBe(JSON.stringify({
      titleFieldId: 'fld_title',
      columns: 4,
      cardSize: 'large',
    }))
  })

  test('returns 409 when creating a view with an existing id', async () => {
    const { app } = await createApp({
      tokenPerms: ['multitable:write'],
      queryHandler: async (sql, params) => {
        if (sql.includes('SELECT id FROM meta_sheets WHERE id = $1')) {
          expect(params).toEqual(['sheet_ops'])
          return { rows: [{ id: 'sheet_ops' }] }
        }
        if (sql.includes('INSERT INTO meta_views')) {
          return { rows: [], rowCount: 0 }
        }
        throw new Error(`Unhandled SQL in test: ${sql}`)
      },
    })

    const response = await request(app)
      .post('/api/multitable/views')
      .send({
        id: 'view_gallery',
        sheetId: 'sheet_ops',
        name: 'Gallery',
        type: 'gallery',
      })
      .expect(409)

    expect(response.body.ok).toBe(false)
    expect(response.body.error.code).toBe('CONFLICT')
    expect(response.body.error.message).toBe('View already exists: view_gallery')
  })

  test('auto-creates a default grid view when GET /views sees an empty sheet', async () => {
    let insertedDefaultView = false

    const { app } = await createApp({
      tokenPerms: ['multitable:read'],
      queryHandler: async (sql, params) => {
        if (sql.includes('SELECT id FROM meta_sheets WHERE id = $1')) {
          expect(params).toEqual(['sheet_ops'])
          return { rows: [{ id: 'sheet_ops' }] }
        }
        if (sql.includes('FROM meta_views WHERE sheet_id = $1 ORDER BY created_at ASC LIMIT 200')) {
          if (!insertedDefaultView) {
            return { rows: [], rowCount: 0 }
          }
          return {
            rows: [{
              id: 'view_default',
              sheet_id: 'sheet_ops',
              name: '默认视图',
              type: 'grid',
              filter_info: {},
              sort_info: {},
              group_info: {},
              hidden_field_ids: [],
              config: {},
            }],
            rowCount: 1,
          }
        }
        if (sql.includes('INSERT INTO meta_views')) {
          insertedDefaultView = true
          return { rows: [], rowCount: 1 }
        }
        if (sql.includes('FROM meta_views') && sql.includes('WHERE id = $1')) {
          return {
            rows: [{
              id: params?.[0] ?? 'view_default',
              sheet_id: 'sheet_ops',
              name: '默认视图',
              type: 'grid',
              filter_info: {},
              sort_info: {},
              group_info: {},
              hidden_field_ids: [],
              config: {},
            }],
            rowCount: 1,
          }
        }
        throw new Error(`Unhandled SQL in test: ${sql}`)
      },
    })

    const response = await request(app)
      .get('/api/multitable/views')
      .query({ sheetId: 'sheet_ops' })
      .expect(200)

    expect(response.body.ok).toBe(true)
    expect(response.body.data.views).toEqual([
      expect.objectContaining({
        sheetId: 'sheet_ops',
        name: '默认视图',
        type: 'grid',
      }),
    ])
  })

  test('updates view config and groupInfo through PATCH /views/:viewId', async () => {
    let updateParams: unknown[] | undefined

    const { app } = await createApp({
      tokenPerms: ['multitable:write'],
      queryHandler: async (sql, params) => {
        if (sql.includes('SELECT id, sheet_id, name, type, filter_info, sort_info, group_info, hidden_field_ids, config FROM meta_views WHERE id = $1')) {
          expect(params).toEqual(['view_kanban'])
          return {
            rows: [{
              id: 'view_kanban',
              sheet_id: 'sheet_ops',
              name: 'Kanban',
              type: 'kanban',
              filter_info: {},
              sort_info: {},
              group_info: { fieldId: 'fld_status_old' },
              hidden_field_ids: [],
              config: { groupFieldId: 'fld_status_old', cardFieldIds: ['fld_title'] },
            }],
          }
        }
        if (sql.includes('UPDATE meta_views')) {
          updateParams = params
          return { rows: [], rowCount: 1 }
        }
        throw new Error(`Unhandled SQL in test: ${sql}`)
      },
    })

    const response = await request(app)
      .patch('/api/multitable/views/view_kanban')
      .send({
        groupInfo: { fieldId: 'fld_status' },
        config: {
          groupFieldId: 'fld_status',
          cardFieldIds: ['fld_title', 'fld_owner'],
        },
      })
      .expect(200)

    expect(response.body.ok).toBe(true)
    expect(response.body.data.view).toMatchObject({
      id: 'view_kanban',
      sheetId: 'sheet_ops',
      type: 'kanban',
      groupInfo: { fieldId: 'fld_status' },
      config: {
        groupFieldId: 'fld_status',
        cardFieldIds: ['fld_title', 'fld_owner'],
      },
    })
    expect(updateParams?.[0]).toBe('view_kanban')
    expect(updateParams?.[5]).toBe(JSON.stringify({ fieldId: 'fld_status' }))
    expect(updateParams?.[7]).toBe(JSON.stringify({
      groupFieldId: 'fld_status',
      cardFieldIds: ['fld_title', 'fld_owner'],
    }))
  })

  test('deletes a view by id through DELETE /views/:viewId', async () => {
    const { app } = await createApp({
      tokenPerms: ['multitable:write'],
      queryHandler: async (sql, params) => {
        if (sql.includes('DELETE FROM meta_views WHERE id = $1')) {
          expect(params).toEqual(['view_kanban'])
          return { rows: [], rowCount: 1 }
        }
        throw new Error(`Unhandled SQL in test: ${sql}`)
      },
    })

    const response = await request(app)
      .delete('/api/multitable/views/view_kanban')
      .expect(200)

    expect(response.body.ok).toBe(true)
    expect(response.body.data).toEqual({ deleted: 'view_kanban' })
  })

  test('returns 404 when deleting a missing view through DELETE /views/:viewId', async () => {
    const { app } = await createApp({
      tokenPerms: ['multitable:write'],
      queryHandler: async (sql, params) => {
        if (sql.includes('DELETE FROM meta_views WHERE id = $1')) {
          expect(params).toEqual(['view_missing'])
          return { rows: [], rowCount: 0 }
        }
        throw new Error(`Unhandled SQL in test: ${sql}`)
      },
    })

    const response = await request(app)
      .delete('/api/multitable/views/view_missing')
      .expect(404)

    expect(response.body.ok).toBe(false)
    expect(response.body.error.code).toBe('NOT_FOUND')
    expect(response.body.error.message).toBe('View not found: view_missing')
  })
})
