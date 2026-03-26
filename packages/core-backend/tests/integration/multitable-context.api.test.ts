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
  tokenRoles?: string[]
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
      roles: args.tokenRoles ?? [],
      perms: args.tokenPerms ?? [],
    }
    next()
  })
  app.use('/api/multitable', univerMetaRouter())

  return { app, mockPool }
}

describe('Multitable context API', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.resetModules()
  })

  test('returns base, selected sheet, views, and capability set', async () => {
    const { app } = await createApp({
      tokenPerms: ['multitable:read', 'comments:write', 'workflow:execute'],
      queryHandler: async (sql, params) => {
        if (sql.includes('FROM meta_sheets s') && sql.includes('LEFT JOIN meta_bases')) {
          expect(params).toEqual(['sheet_ops'])
          return {
            rows: [{
              id: 'sheet_ops',
              base_id: 'base_ops',
              name: 'Orders',
              description: 'Ops records',
            }],
          }
        }
        if (sql.includes('FROM meta_bases') && sql.includes('WHERE id = $1')) {
          expect(params).toEqual(['base_ops'])
          return {
            rows: [{
              id: 'base_ops',
              name: 'Ops Base',
              icon: 'table',
              color: '#1677ff',
              owner_id: 'owner_1',
              workspace_id: 'workspace_1',
            }],
          }
        }
        if (sql.includes('FROM meta_sheets') && sql.includes('WHERE base_id = $1')) {
          expect(params).toEqual(['base_ops'])
          return {
            rows: [
              { id: 'sheet_ops', base_id: 'base_ops', name: 'Orders', description: 'Ops records' },
              { id: 'sheet_vendors', base_id: 'base_ops', name: 'Vendors', description: null },
            ],
          }
        }
        if (sql.includes('FROM meta_views') && sql.includes('WHERE sheet_id = $1')) {
          expect(params).toEqual(['sheet_ops'])
          return {
            rows: [
              { id: 'view_grid', sheet_id: 'sheet_ops', name: 'Grid', type: 'grid', filter_info: {}, sort_info: {}, group_info: {}, hidden_field_ids: [], config: {} },
              { id: 'view_form', sheet_id: 'sheet_ops', name: 'Intake Form', type: 'form', filter_info: {}, sort_info: {}, group_info: {}, hidden_field_ids: [], config: {} },
            ],
          }
        }
        throw new Error(`Unhandled SQL in test: ${sql}`)
      },
    })

    const response = await request(app)
      .get('/api/multitable/context')
      .query({ sheetId: 'sheet_ops' })
      .expect(200)

    expect(response.body.ok).toBe(true)
    expect(response.body.data.base).toMatchObject({ id: 'base_ops', name: 'Ops Base' })
    expect(response.body.data.sheet).toMatchObject({ id: 'sheet_ops', baseId: 'base_ops', name: 'Orders' })
    expect(response.body.data.sheets).toHaveLength(2)
    expect(response.body.data.views).toHaveLength(2)
    expect(response.body.data.capabilities).toEqual({
      canRead: true,
      canCreateRecord: false,
      canEditRecord: false,
      canDeleteRecord: false,
      canManageFields: false,
      canManageViews: false,
      canComment: true,
      canManageAutomation: true,
    })
  })

  test('uses the first sheet in a base when only baseId is provided', async () => {
    const { app } = await createApp({
      tokenPerms: ['multitable:read'],
      queryHandler: async (sql, params) => {
        if (sql.includes('FROM meta_bases') && sql.includes('WHERE id = $1')) {
          expect(params).toEqual(['base_ops'])
          return {
            rows: [{
              id: 'base_ops',
              name: 'Ops Base',
              icon: null,
              color: null,
              owner_id: null,
              workspace_id: null,
            }],
          }
        }
        if (sql.includes('FROM meta_sheets') && sql.includes('WHERE base_id = $1')) {
          return {
            rows: [
              { id: 'sheet_a', base_id: 'base_ops', name: 'Alpha', description: null },
              { id: 'sheet_b', base_id: 'base_ops', name: 'Beta', description: null },
            ],
          }
        }
        if (sql.includes('FROM meta_views') && sql.includes('WHERE sheet_id = $1')) {
          expect(params).toEqual(['sheet_a'])
          return {
            rows: [
              { id: 'view_alpha', sheet_id: 'sheet_a', name: 'Grid', type: 'grid', filter_info: {}, sort_info: {}, group_info: {}, hidden_field_ids: [], config: {} },
            ],
          }
        }
        throw new Error(`Unhandled SQL in test: ${sql}`)
      },
    })

    const response = await request(app)
      .get('/api/multitable/context')
      .query({ baseId: 'base_ops' })
      .expect(200)

    expect(response.body.data.sheet).toMatchObject({ id: 'sheet_a', baseId: 'base_ops', name: 'Alpha' })
    expect(response.body.data.views).toEqual([
      expect.objectContaining({ id: 'view_alpha', sheetId: 'sheet_a', type: 'grid' }),
    ])
  })

  test('creates a sheet under the legacy base when baseId is omitted', async () => {
    const { app, mockPool } = await createApp({
      tokenPerms: ['multitable:write'],
      queryHandler: async (sql, params) => {
        if (sql.includes('INSERT INTO meta_bases')) {
          expect(params?.[0]).toBe('base_legacy')
          return { rows: [], rowCount: 1 }
        }
        if (sql.includes('INSERT INTO meta_sheets')) {
          expect(params).toEqual([
            expect.any(String),
            'base_legacy',
            'Vendor Intake',
            'Main vendor list',
          ])
          return { rows: [], rowCount: 1 }
        }
        throw new Error(`Unhandled SQL in test: ${sql}`)
      },
    })

    const response = await request(app)
      .post('/api/multitable/sheets')
      .send({ name: 'Vendor Intake', description: 'Main vendor list' })
      .expect(200)

    expect(response.body.ok).toBe(true)
    expect(response.body.data.sheet.baseId).toBe('base_legacy')
    expect(response.body.data.sheet.seeded).toBe(false)
    expect(mockPool.transaction).toHaveBeenCalledTimes(1)
  })

  test('rejects context access without multitable read permission', async () => {
    const { app, mockPool } = await createApp({
      tokenPerms: [],
      fallbackPermissions: [],
      fallbackHasPermission: false,
      queryHandler: async () => ({ rows: [], rowCount: 0 }),
    })

    const response = await request(app)
      .get('/api/multitable/context')
      .query({ baseId: 'base_ops' })
      .expect(403)

    expect(response.body).toEqual({ error: 'Insufficient permissions' })
    expect(mockPool.query).not.toHaveBeenCalled()
  })

  test('hides the system people sheet from multitable context selection', async () => {
    const { app } = await createApp({
      tokenPerms: ['multitable:read'],
      queryHandler: async (sql, params) => {
        if (sql.includes('FROM meta_bases') && sql.includes('WHERE id = $1')) {
          expect(params).toEqual(['base_ops'])
          return {
            rows: [{
              id: 'base_ops',
              name: 'Ops Base',
              icon: null,
              color: null,
              owner_id: null,
              workspace_id: null,
            }],
          }
        }
        if (sql.includes('FROM meta_sheets') && sql.includes('WHERE base_id = $1')) {
          return {
            rows: [
              { id: 'sheet_people', base_id: 'base_ops', name: 'People', description: '__metasheet_system:people__' },
              { id: 'sheet_orders', base_id: 'base_ops', name: 'Orders', description: null },
            ],
          }
        }
        if (sql.includes('FROM meta_views') && sql.includes('WHERE sheet_id = $1')) {
          expect(params).toEqual(['sheet_orders'])
          return {
            rows: [
              { id: 'view_orders', sheet_id: 'sheet_orders', name: 'Grid', type: 'grid', filter_info: {}, sort_info: {}, group_info: {}, hidden_field_ids: [], config: {} },
            ],
          }
        }
        throw new Error(`Unhandled SQL in test: ${sql}`)
      },
    })

    const response = await request(app)
      .get('/api/multitable/context')
      .query({ baseId: 'base_ops' })
      .expect(200)

    expect(response.body.data.sheet).toMatchObject({ id: 'sheet_orders', name: 'Orders' })
    expect(response.body.data.sheets).toEqual([
      expect.objectContaining({ id: 'sheet_orders', name: 'Orders' }),
    ])
  })

  test('prepares a person field preset by provisioning a people sheet and syncing users', async () => {
    let peopleSheetId = ''
    const fieldIdsByName = new Map<string, string>()

    const { app } = await createApp({
      tokenPerms: ['multitable:write'],
      queryHandler: async (sql, params) => {
        if (sql.includes('SELECT id, base_id, name, description FROM meta_sheets WHERE id = $1')) {
          expect(params).toEqual(['sheet_ops'])
          return { rows: [{ id: 'sheet_ops', base_id: 'base_ops', name: 'Orders', description: null }] }
        }
        if (sql.includes('FROM meta_sheets') && sql.includes('WHERE base_id = $1')) {
          expect(params).toEqual(['base_ops'])
          return { rows: [{ id: 'sheet_ops', base_id: 'base_ops', name: 'Orders', description: null }] }
        }
        if (sql.includes('INSERT INTO meta_sheets')) {
          peopleSheetId = String(params?.[0] ?? '')
          expect(params).toEqual([
            expect.any(String),
            'base_ops',
            'People',
            '__metasheet_system:people__',
          ])
          return { rows: [], rowCount: 1 }
        }
        if (sql.includes('SELECT id, name, type, "order" FROM meta_fields WHERE sheet_id = $1')) {
          expect(params).toEqual([peopleSheetId])
          return { rows: [] }
        }
        if (sql.includes('INSERT INTO meta_fields')) {
          const fieldId = String(params?.[0] ?? '')
          const fieldName = String(params?.[2] ?? '')
          fieldIdsByName.set(fieldName, fieldId)
          return { rows: [], rowCount: 1 }
        }
        if (sql.includes('SELECT id, email, name, avatar_url') && sql.includes('FROM users')) {
          return {
            rows: [
              { id: 'user_amy', email: 'amy@example.com', name: 'Amy', avatar_url: 'https://cdn.example.com/amy.png' },
            ],
          }
        }
        if (sql.includes('SELECT id, data FROM meta_records WHERE sheet_id = $1')) {
          expect(params).toEqual([peopleSheetId])
          return { rows: [] }
        }
        if (sql.includes('INSERT INTO meta_records')) {
          expect(params?.[1]).toBe(peopleSheetId)
          const payload = JSON.parse(String(params?.[2] ?? '{}'))
          expect(payload).toEqual({
            [fieldIdsByName.get('User ID')!]: 'user_amy',
            [fieldIdsByName.get('Name')!]: 'Amy',
            [fieldIdsByName.get('Email')!]: 'amy@example.com',
            [fieldIdsByName.get('Avatar URL')!]: 'https://cdn.example.com/amy.png',
          })
          return { rows: [], rowCount: 1 }
        }
        throw new Error(`Unhandled SQL in test: ${sql}`)
      },
    })

    const response = await request(app)
      .post('/api/multitable/person-fields/prepare')
      .send({ sheetId: 'sheet_ops' })
      .expect(200)

    expect(response.body.data.targetSheet).toMatchObject({
      id: peopleSheetId,
      baseId: 'base_ops',
      name: 'People',
      description: '__metasheet_system:people__',
    })
    expect(response.body.data.fieldProperty).toEqual({
      foreignSheetId: peopleSheetId,
      limitSingleRecord: true,
      refKind: 'user',
    })
  })
})
