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
    if (sql.includes('FROM meta_view_permissions')) {
      return { rows: [], rowCount: 0 }
    }
    if (sql.includes('FROM field_permissions')) {
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
  tokenRoles?: string[]
  requestPermissions?: string[]
  requestRole?: string
  queryHandler?: QueryHandler
  fallbackPermissions?: string[]
  fallbackHasPermission?: boolean
}) {
  vi.resetModules()
  vi.doMock('../../src/rbac/service', () => ({
    isAdmin: vi.fn().mockResolvedValue(false),
    userHasPermission: vi.fn().mockImplementation(async (_userId: string, code: string) => {
      if (code === 'multitable:read' || code === 'multitable:write' || code === 'multitable:share') {
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
      role: args.requestRole,
      permissions: args.requestPermissions,
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
        if (sql.includes('SELECT id, name, type, property, "order" FROM meta_fields WHERE sheet_id = $1 ORDER BY "order" ASC, id ASC')) {
          expect(params).toEqual(['sheet_ops'])
          return {
            rows: [
              { id: 'fld_name', name: 'Name', type: 'string', property: {}, order: 1 },
              { id: 'fld_status', name: 'Status', type: 'select', property: { options: [{ value: 'open' }] }, order: 2 },
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
      canManageSheetAccess: false,
      canManageViews: false,
      canComment: true,
      canManageAutomation: true,
      canExport: true,
    })
    expect(response.body.data.capabilityOrigin).toEqual({
      source: 'global-rbac',
      hasSheetAssignments: false,
    })
    expect(response.body.data.viewPermissions).toEqual({
      view_grid: {
        canAccess: true,
        canConfigure: false,
        canDelete: false,
      },
      view_form: {
        canAccess: true,
        canConfigure: false,
        canDelete: false,
      },
    })
  })

  test('marks computed and explicitly readonly fields as readOnly in scoped field permissions', async () => {
    const { app } = await createApp({
      tokenPerms: ['multitable:read', 'multitable:write'],
      queryHandler: async (sql, params) => {
        if (sql.includes('SELECT id, sheet_id, name, type, filter_info, sort_info, group_info, hidden_field_ids, config FROM meta_views WHERE id = $1')) {
          expect(params).toEqual(['view_grid'])
          return {
            rows: [{
              id: 'view_grid',
              sheet_id: 'sheet_ops',
              name: 'Grid',
              type: 'grid',
              filter_info: {},
              sort_info: {},
              group_info: {},
              hidden_field_ids: ['fld_lookup'],
              config: {},
            }],
          }
        }
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
            ],
          }
        }
        if (sql.includes('FROM meta_views') && sql.includes('WHERE sheet_id = $1')) {
          expect(params).toEqual(['sheet_ops'])
          return {
            rows: [
              { id: 'view_grid', sheet_id: 'sheet_ops', name: 'Grid', type: 'grid', filter_info: {}, sort_info: {}, group_info: {}, hidden_field_ids: ['fld_lookup'], config: {} },
            ],
          }
        }
        if (sql.includes('SELECT id, name, type, property, "order" FROM meta_fields WHERE sheet_id = $1 ORDER BY "order" ASC, id ASC')) {
          expect(params).toEqual(['sheet_ops'])
          return {
            rows: [
              { id: 'fld_title', name: 'Title', type: 'string', property: {}, order: 1 },
              { id: 'fld_formula', name: 'Total', type: 'formula', property: { expression: '{fld_amount} * 2' }, order: 2 },
              { id: 'fld_lookup', name: 'Vendor Name', type: 'lookup', property: { linkFieldId: 'fld_vendor', targetFieldId: 'fld_name' }, order: 3 },
              { id: 'fld_locked', name: 'Locked', type: 'string', property: { readonly: true }, order: 4 },
              { id: 'fld_secret', name: 'Secret', type: 'string', property: { hidden: true }, order: 5 },
            ],
          }
        }
        throw new Error(`Unhandled SQL in test: ${sql}`)
      },
    })

    const response = await request(app)
      .get('/api/multitable/context')
      .query({ sheetId: 'sheet_ops', viewId: 'view_grid' })
      .expect(200)

    expect(response.body.data.fieldPermissions).toEqual({
      fld_title: { visible: true, readOnly: false },
      fld_formula: { visible: true, readOnly: true },
      fld_lookup: { visible: false, readOnly: true },
      fld_locked: { visible: true, readOnly: true },
      fld_secret: { visible: false, readOnly: false },
    })
  })

  test('derives multitable capabilities from req.user role and permissions when token roles/perms are absent', async () => {
    const { app } = await createApp({
      requestRole: 'admin',
      requestPermissions: ['*:*'],
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
            ],
          }
        }
        if (sql.includes('FROM meta_views') && sql.includes('WHERE sheet_id = $1')) {
          expect(params).toEqual(['sheet_ops'])
          return {
            rows: [
              { id: 'view_grid', sheet_id: 'sheet_ops', name: 'Grid', type: 'grid', filter_info: {}, sort_info: {}, group_info: {}, hidden_field_ids: [], config: {} },
            ],
          }
        }
        if (sql.includes('SELECT id, name, type, property, "order" FROM meta_fields WHERE sheet_id = $1 ORDER BY "order" ASC, id ASC')) {
          expect(params).toEqual(['sheet_ops'])
          return {
            rows: [
              { id: 'fld_name', name: 'Name', type: 'string', property: {}, order: 1 },
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

    expect(response.body.data.capabilities).toEqual({
      canRead: true,
      canCreateRecord: true,
      canEditRecord: true,
      canDeleteRecord: true,
      canManageFields: true,
      canManageSheetAccess: true,
      canManageViews: true,
      canComment: true,
      canManageAutomation: true,
      canExport: true,
    })
    expect(response.body.data.viewPermissions).toEqual({
      view_grid: {
        canAccess: true,
        canConfigure: true,
        canDelete: true,
      },
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
        if (sql.includes('SELECT id, name, type, property, "order" FROM meta_fields WHERE sheet_id = $1 ORDER BY "order" ASC, id ASC')) {
          expect(params).toEqual(['sheet_a'])
          return {
            rows: [
              { id: 'fld_title', name: 'Title', type: 'string', property: {}, order: 1 },
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

  test('resolves context by viewId and returns the target view config', async () => {
    const { app } = await createApp({
      tokenPerms: ['multitable:read'],
      queryHandler: async (sql, params) => {
        if (sql.includes('FROM meta_views WHERE id = $1')) {
          expect(params).toEqual(['view_calendar'])
          return {
            rows: [{
              id: 'view_calendar',
              sheet_id: 'sheet_ops',
              name: 'Calendar',
              type: 'calendar',
              filter_info: { mode: 'upcoming' },
              sort_info: {},
              group_info: {},
              hidden_field_ids: [],
              config: { defaultView: 'week', colorRules: [{ field: 'category', value: 'meeting', color: '#00f' }] },
            }],
          }
        }
        if (sql.includes('FROM meta_sheets s') && sql.includes('LEFT JOIN meta_bases')) {
          expect(params).toEqual(['sheet_ops'])
          return {
            rows: [{
              id: 'sheet_ops',
              base_id: 'base_ops',
              name: 'Ops',
              description: 'Ops records',
              base_ref_id: 'base_ops',
              base_name: 'Ops Base',
              base_icon: 'table',
              base_color: '#1677ff',
              base_owner_id: 'owner_1',
              base_workspace_id: 'workspace_1',
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
              { id: 'sheet_ops', base_id: 'base_ops', name: 'Ops', description: 'Ops records' },
            ],
          }
        }
        if (sql.includes('FROM meta_views') && sql.includes('WHERE sheet_id = $1')) {
          expect(params).toEqual(['sheet_ops'])
          return {
            rows: [{
              id: 'view_calendar',
              sheet_id: 'sheet_ops',
              name: 'Calendar',
              type: 'calendar',
              filter_info: { mode: 'upcoming' },
              sort_info: {},
              group_info: {},
              hidden_field_ids: [],
              config: { defaultView: 'week', colorRules: [{ field: 'category', value: 'meeting', color: '#00f' }] },
            }],
          }
        }
        if (sql.includes('SELECT id, name, type, property, "order" FROM meta_fields WHERE sheet_id = $1 ORDER BY "order" ASC, id ASC')) {
          expect(params).toEqual(['sheet_ops'])
          return {
            rows: [
              { id: 'fld_due_date', name: 'Due Date', type: 'date', property: {}, order: 1 },
            ],
          }
        }
        throw new Error(`Unhandled SQL in test: ${sql}`)
      },
    })

    const response = await request(app)
      .get('/api/multitable/context')
      .query({ viewId: 'view_calendar' })
      .expect(200)

    expect(response.body.ok).toBe(true)
    expect(response.body.data.sheet).toMatchObject({ id: 'sheet_ops', baseId: 'base_ops', name: 'Ops' })
    expect(response.body.data.views).toEqual([
      expect.objectContaining({
        id: 'view_calendar',
        sheetId: 'sheet_ops',
        type: 'calendar',
        config: expect.objectContaining({ defaultView: 'week' }),
      }),
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

  test('allows create sheet under an owned base without global multitable write', async () => {
    const { app, mockPool } = await createApp({
      tokenPerms: [],
      fallbackPermissions: [],
      fallbackHasPermission: false,
      queryHandler: async (sql, params) => {
        if (sql.includes('SELECT id, owner_id FROM meta_bases WHERE id = $1 AND deleted_at IS NULL')) {
          expect(params).toEqual(['base_ops'])
          return {
            rows: [{ id: 'base_ops', owner_id: 'user_multitable_1' }],
          }
        }
        if (sql.includes('INSERT INTO meta_sheets')) {
          expect(params).toEqual([
            expect.any(String),
            'base_ops',
            'Owned Sheet',
            'Created by base owner',
          ])
          return { rows: [], rowCount: 1 }
        }
        throw new Error(`Unhandled SQL in test: ${sql}`)
      },
    })

    const response = await request(app)
      .post('/api/multitable/sheets')
      .send({ baseId: 'base_ops', name: 'Owned Sheet', description: 'Created by base owner' })
      .expect(200)

    expect(response.body.ok).toBe(true)
    expect(response.body.data.sheet).toMatchObject({
      baseId: 'base_ops',
      name: 'Owned Sheet',
      description: 'Created by base owner',
      seeded: false,
    })
    expect(mockPool.transaction).toHaveBeenCalledTimes(1)
  })

  test('rejects create sheet under an unowned base without global multitable write', async () => {
    const { app } = await createApp({
      tokenPerms: [],
      fallbackPermissions: [],
      fallbackHasPermission: false,
      queryHandler: async (sql, params) => {
        if (sql.includes('SELECT id, owner_id FROM meta_bases WHERE id = $1 AND deleted_at IS NULL')) {
          expect(params).toEqual(['base_ops'])
          return {
            rows: [{ id: 'base_ops', owner_id: 'someone_else' }],
          }
        }
        throw new Error(`Unhandled SQL in test: ${sql}`)
      },
    })

    const response = await request(app)
      .post('/api/multitable/sheets')
      .send({ baseId: 'base_ops', name: 'Blocked Sheet' })
      .expect(403)

    expect(response.body).toEqual({
      ok: false,
      error: { code: 'FORBIDDEN', message: 'Insufficient permissions' },
    })
  })

  test('deletes a multitable sheet by id', async () => {
    const { app } = await createApp({
      tokenPerms: ['multitable:write'],
      queryHandler: async (sql, params) => {
        if (sql.includes('SELECT id FROM meta_sheets WHERE id = $1')) {
          expect(params).toEqual(['sheet_ops'])
          return { rows: [{ id: 'sheet_ops' }], rowCount: 1 }
        }
        if (sql.includes('DELETE FROM meta_sheets WHERE id = $1')) {
          expect(params).toEqual(['sheet_ops'])
          return { rows: [], rowCount: 1 }
        }
        throw new Error(`Unhandled SQL in test: ${sql}`)
      },
    })

    const response = await request(app)
      .delete('/api/multitable/sheets/sheet_ops')
      .expect(200)

    expect(response.body.ok).toBe(true)
    expect(response.body.data).toEqual({ deleted: 'sheet_ops' })
  })

  test('returns 404 when deleting a missing multitable sheet', async () => {
    const { app } = await createApp({
      tokenPerms: ['multitable:write'],
      queryHandler: async (sql, params) => {
        if (sql.includes('SELECT id FROM meta_sheets WHERE id = $1')) {
          expect(params).toEqual(['sheet_missing'])
          return { rows: [], rowCount: 0 }
        }
        if (sql.includes('DELETE FROM meta_sheets WHERE id = $1')) {
          expect(params).toEqual(['sheet_missing'])
          return { rows: [], rowCount: 0 }
        }
        throw new Error(`Unhandled SQL in test: ${sql}`)
      },
    })

    const response = await request(app)
      .delete('/api/multitable/sheets/sheet_missing')
      .expect(404)

    expect(response.body.ok).toBe(false)
    expect(response.body.error.code).toBe('NOT_FOUND')
    expect(response.body.error.message).toBe('Sheet not found: sheet_missing')
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

    expect(response.body).toEqual({
      ok: false,
      error: { code: 'FORBIDDEN', message: 'Insufficient permissions' },
    })
    expect(mockPool.query).toHaveBeenCalledTimes(2)
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
        if (sql.includes('SELECT id, name, type, property, "order" FROM meta_fields WHERE sheet_id = $1 ORDER BY "order" ASC, id ASC')) {
          expect(params).toEqual(['sheet_orders'])
          return {
            rows: [
              { id: 'fld_title', name: 'Title', type: 'string', property: {}, order: 1 },
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

  test('accepts date fields in create and update multitable field contracts', async () => {
    const { app } = await createApp({
      tokenPerms: ['multitable:write'],
      queryHandler: async (sql, params) => {
        if (sql.includes('SELECT id FROM meta_sheets WHERE id = $1')) {
          expect(params).toEqual(['sheet_ops'])
          return { rows: [{ id: 'sheet_ops' }] }
        }
        if (sql.includes('SELECT COALESCE(MAX("order"), -1) AS max_order FROM meta_fields')) {
          expect(params).toEqual(['sheet_ops'])
          return { rows: [{ max_order: 2 }] }
        }
        if (sql.includes('INSERT INTO meta_fields')) {
          expect(params).toEqual([
            'fld_due_date',
            'sheet_ops',
            'Due Date',
            'date',
            '{}',
            3,
          ])
          return {
            rows: [{
              id: 'fld_due_date',
              name: 'Due Date',
              type: 'date',
              property: {},
              order: 3,
            }],
          }
        }
        if (sql.includes('SELECT id, name, type, property, "order" FROM meta_fields WHERE id = $1')) {
          if (params?.[0] === 'fld_due_date') {
            return {
              rows: [{
                id: 'fld_due_date',
                name: 'Due Date',
                type: 'date',
                property: {},
                order: 3,
              }],
            }
          }
          throw new Error(`Unexpected field lookup params: ${JSON.stringify(params)}`)
        }
        if (sql.includes('SELECT id, sheet_id, name, type, property, "order" FROM meta_fields WHERE id = $1')) {
          if (params?.[0] === 'fld_due_date') {
            return {
              rows: [{
                id: 'fld_due_date',
                sheet_id: 'sheet_ops',
                name: 'Due Date',
                type: 'date',
                property: {},
                order: 3,
              }],
            }
          }
          throw new Error(`Unexpected field lookup params: ${JSON.stringify(params)}`)
        }
        if (sql.includes('SELECT id, sheet_id FROM meta_fields WHERE id = $1')) {
          if (params?.[0] === 'fld_due_date') {
            return {
              rows: [{ id: 'fld_due_date', sheet_id: 'sheet_ops' }],
            }
          }
          throw new Error(`Unexpected field lookup params: ${JSON.stringify(params)}`)
        }
        if (sql.includes('UPDATE meta_fields') && sql.includes('SET name = $2, type = $3, property = $4::jsonb, "order" = $5')) {
          expect(params).toEqual([
            'fld_due_date',
            'Due Date',
            'date',
            '{}',
            3,
          ])
          return {
            rows: [{
              id: 'fld_due_date',
              name: 'Due Date',
              type: 'date',
              property: {},
              order: 3,
            }],
          }
        }
        throw new Error(`Unhandled SQL in test: ${sql}`)
      },
    })

    const createResponse = await request(app)
      .post('/api/multitable/fields')
      .send({
        id: 'fld_due_date',
        sheetId: 'sheet_ops',
        name: 'Due Date',
        type: 'date',
      })
      .expect(201)

    expect(createResponse.body.data.field).toMatchObject({
      id: 'fld_due_date',
      name: 'Due Date',
      type: 'date',
      order: 3,
    })

    const updateResponse = await request(app)
      .patch('/api/multitable/fields/fld_due_date')
      .send({
        type: 'date',
      })
      .expect(200)

    expect(updateResponse.body.data.field).toMatchObject({
      id: 'fld_due_date',
      name: 'Due Date',
      type: 'date',
      order: 3,
    })
  })

  test('accepts MF2 field types in create and update multitable field contracts', async () => {
    const { app } = await createApp({
      tokenPerms: ['multitable:write'],
      queryHandler: async (sql, params) => {
        if (sql.includes('SELECT id FROM meta_sheets WHERE id = $1')) {
          expect(params).toEqual(['sheet_ops'])
          return { rows: [{ id: 'sheet_ops' }] }
        }
        if (sql.includes('SELECT COALESCE(MAX("order"), -1) AS max_order FROM meta_fields')) {
          expect(params).toEqual(['sheet_ops'])
          return { rows: [{ max_order: 3 }] }
        }
        if (sql.includes('INSERT INTO meta_fields')) {
          expect(params).toEqual([
            'fld_amount',
            'sheet_ops',
            'Amount',
            'currency',
            '{"code":"usd","decimals":2}',
            4,
          ])
          return {
            rows: [{
              id: 'fld_amount',
              name: 'Amount',
              type: 'currency',
              property: { code: 'usd', decimals: 2 },
              order: 4,
            }],
          }
        }
        if (sql.includes('SELECT id, name, type, property, "order" FROM meta_fields WHERE id = $1')) {
          if (params?.[0] === 'fld_amount') {
            return {
              rows: [{
                id: 'fld_amount',
                name: 'Amount',
                type: 'currency',
                property: { code: 'usd', decimals: 2 },
                order: 4,
              }],
            }
          }
          throw new Error(`Unexpected field lookup params: ${JSON.stringify(params)}`)
        }
        if (sql.includes('SELECT id, sheet_id FROM meta_fields WHERE id = $1')) {
          if (params?.[0] === 'fld_amount') {
            return { rows: [{ id: 'fld_amount', sheet_id: 'sheet_ops' }] }
          }
          throw new Error(`Unexpected field lookup params: ${JSON.stringify(params)}`)
        }
        if (sql.includes('SELECT id, sheet_id, name, type, property, "order" FROM meta_fields WHERE id = $1')) {
          if (params?.[0] === 'fld_amount') {
            return {
              rows: [{
                id: 'fld_amount',
                sheet_id: 'sheet_ops',
                name: 'Amount',
                type: 'currency',
                property: { code: 'usd', decimals: 2 },
                order: 4,
              }],
            }
          }
          throw new Error(`Unexpected field lookup params: ${JSON.stringify(params)}`)
        }
        if (sql.includes('UPDATE meta_fields') && sql.includes('SET name = $2, type = $3, property = $4::jsonb, "order" = $5')) {
          expect(params).toEqual([
            'fld_amount',
            'Amount',
            'email',
            '{}',
            4,
          ])
          return {
            rows: [{
              id: 'fld_amount',
              name: 'Amount',
              type: 'email',
              property: {},
              order: 4,
            }],
          }
        }
        throw new Error(`Unhandled SQL in test: ${sql}`)
      },
    })

    const createResponse = await request(app)
      .post('/api/multitable/fields')
      .send({
        id: 'fld_amount',
        sheetId: 'sheet_ops',
        name: 'Amount',
        type: 'currency',
        property: { code: 'usd', decimals: 2 },
      })
      .expect(201)

    expect(createResponse.body.data.field).toMatchObject({
      id: 'fld_amount',
      name: 'Amount',
      type: 'currency',
      property: { code: 'usd', decimals: 2 },
      order: 4,
    })

    const updateResponse = await request(app)
      .patch('/api/multitable/fields/fld_amount')
      .send({
        type: 'email',
        property: {},
      })
      .expect(200)

    expect(updateResponse.body.data.field).toMatchObject({
      id: 'fld_amount',
      name: 'Amount',
      type: 'email',
      property: {},
      order: 4,
    })
  })
})
