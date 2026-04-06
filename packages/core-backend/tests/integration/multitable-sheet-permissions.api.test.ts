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
  requestPermissions?: string[]
  requestRole?: string
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
      id: 'user_sheet_acl_1',
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

describe('Multitable sheet-scoped permissions API', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.resetModules()
  })

  test('narrows context and record actions when sheet permission is read-only', async () => {
    const { app } = await createApp({
      tokenPerms: ['multitable:read', 'multitable:write', 'comments:write'],
      queryHandler: async (sql, params) => {
        if (sql.includes('FROM meta_sheets s') && sql.includes('LEFT JOIN meta_bases')) {
          expect(params).toEqual(['sheet_ops'])
          return {
            rows: [{ id: 'sheet_ops', base_id: 'base_ops', name: 'Orders', description: 'Ops records' }],
          }
        }
        if (sql.includes('FROM meta_bases') && sql.includes('WHERE id = $1')) {
          expect(params).toEqual(['base_ops'])
          return {
            rows: [{ id: 'base_ops', name: 'Ops Base', icon: 'table', color: '#1677ff', owner_id: 'owner_1', workspace_id: 'workspace_1' }],
          }
        }
        if (sql.includes('FROM meta_sheets') && sql.includes('WHERE base_id = $1')) {
          expect(params).toEqual(['base_ops'])
          return {
            rows: [{ id: 'sheet_ops', base_id: 'base_ops', name: 'Orders', description: 'Ops records' }],
          }
        }
        if (sql.includes('FROM spreadsheet_permissions')) {
          expect(params).toEqual(['user_sheet_acl_1', ['sheet_ops']])
          return {
            rows: [{ sheet_id: 'sheet_ops', perm_code: 'spreadsheet:read' }],
          }
        }
        if (sql.includes('FROM meta_views') && sql.includes('WHERE sheet_id = $1')) {
          expect(params).toEqual(['sheet_ops'])
          return {
            rows: [{ id: 'view_grid', sheet_id: 'sheet_ops', name: 'Grid', type: 'grid', filter_info: {}, sort_info: {}, group_info: {}, hidden_field_ids: [], config: {} }],
          }
        }
        if (sql.includes('SELECT id, name, type, property, "order" FROM meta_fields WHERE sheet_id = $1')) {
          expect(params).toEqual(['sheet_ops'])
          return {
            rows: [{ id: 'fld_name', name: 'Name', type: 'string', property: {}, order: 1 }],
          }
        }
        if (sql.includes('SELECT id, base_id, name, description FROM meta_sheets WHERE id = $1')) {
          expect(params).toEqual(['sheet_ops'])
          return {
            rows: [{ id: 'sheet_ops', base_id: 'base_ops', name: 'Orders', description: 'Ops records' }],
          }
        }
        if (sql.includes('SELECT id, sheet_id, version, data, created_by FROM meta_records WHERE id = $1')) {
          expect(params).toEqual(['rec_1'])
          return {
            rows: [{ id: 'rec_1', sheet_id: 'sheet_ops', version: 3, data: { fld_name: 'Order A' } }],
          }
        }
        throw new Error(`Unhandled SQL in test: ${sql}`)
      },
    })

    const contextResponse = await request(app)
      .get('/api/multitable/context')
      .query({ sheetId: 'sheet_ops' })
      .expect(200)

    expect(contextResponse.body.data.capabilities).toEqual({
      canRead: true,
      canCreateRecord: false,
      canEditRecord: false,
      canDeleteRecord: false,
      canManageFields: false,
      canManageViews: false,
      canComment: true,
      canManageAutomation: false,
    })
    expect(contextResponse.body.data.viewPermissions).toEqual({
      view_grid: {
        canAccess: true,
        canConfigure: false,
        canDelete: false,
      },
    })

    const recordResponse = await request(app)
      .get('/api/multitable/records/rec_1')
      .expect(200)

    expect(recordResponse.body.data.rowActions).toEqual({
      canEdit: false,
      canDelete: false,
      canComment: true,
    })
    expect(recordResponse.body.data.capabilities).toMatchObject({
      canRead: true,
      canEditRecord: false,
      canDeleteRecord: false,
    })
  })

  test('rejects create, patch, delete, and form submit when sheet permission is read-only', async () => {
    const { app } = await createApp({
      tokenPerms: ['multitable:read', 'multitable:write', 'comments:write'],
      queryHandler: async (sql, params) => {
        if (sql.includes('FROM spreadsheet_permissions')) {
          expect(params).toEqual(['user_sheet_acl_1', ['sheet_ops']])
          return {
            rows: [{ sheet_id: 'sheet_ops', perm_code: 'spreadsheet:read' }],
          }
        }
        if (sql.includes('SELECT id FROM meta_sheets WHERE id = $1 AND deleted_at IS NULL')) {
          expect(params).toEqual(['sheet_ops'])
          return { rows: [{ id: 'sheet_ops' }] }
        }
        if (sql.includes('SELECT id, base_id, name, description FROM meta_sheets WHERE id = $1')) {
          expect(params).toEqual(['sheet_ops'])
          return { rows: [{ id: 'sheet_ops', base_id: 'base_ops', name: 'Ops', description: null }] }
        }
        if (sql.includes('SELECT id, sheet_id, name, type, filter_info, sort_info, group_info, hidden_field_ids, config FROM meta_views WHERE id = $1')) {
          expect(params).toEqual(['view_form_ops'])
          return {
            rows: [{ id: 'view_form_ops', sheet_id: 'sheet_ops', name: 'Form', type: 'form', filter_info: {}, sort_info: {}, group_info: {}, hidden_field_ids: [], config: {} }],
          }
        }
        if (
          sql.includes('SELECT id, sheet_id FROM meta_records WHERE id = $1')
          || sql.includes('SELECT id, sheet_id, created_by FROM meta_records WHERE id = $1')
        ) {
          expect(params).toEqual(['rec_1'])
          return { rows: [{ id: 'rec_1', sheet_id: 'sheet_ops' }] }
        }
        throw new Error(`Unhandled SQL in test: ${sql}`)
      },
    })

    const createResponse = await request(app)
      .post('/api/multitable/records')
      .send({ sheetId: 'sheet_ops', data: { fld_name: 'Blocked create' } })
      .expect(403)
    expect(createResponse.body).toEqual({
      ok: false,
      error: { code: 'FORBIDDEN', message: 'Insufficient permissions' },
    })

    const patchResponse = await request(app)
      .patch('/api/multitable/records/rec_1')
      .send({ data: { fld_name: 'Blocked patch' } })
      .expect(403)
    expect(patchResponse.body).toEqual({
      ok: false,
      error: { code: 'FORBIDDEN', message: 'Insufficient permissions' },
    })

    const deleteResponse = await request(app)
      .delete('/api/multitable/records/rec_1')
      .expect(403)
    expect(deleteResponse.body).toEqual({
      ok: false,
      error: { code: 'FORBIDDEN', message: 'Insufficient permissions' },
    })

    const submitResponse = await request(app)
      .post('/api/multitable/views/view_form_ops/submit')
      .send({ data: { fld_name: 'Blocked submit' } })
      .expect(403)
    expect(submitResponse.body).toEqual({
      ok: false,
      error: { code: 'FORBIDDEN', message: 'Insufficient permissions' },
    })
  })

  test('returns owner-scoped row action overrides when sheet permission is write-own', async () => {
    const { app } = await createApp({
      tokenPerms: ['multitable:read', 'multitable:write', 'comments:write'],
      queryHandler: async (sql, params) => {
        if (sql.includes('FROM spreadsheet_permissions')) {
          expect(params).toEqual(['user_sheet_acl_1', ['sheet_ops']])
          return {
            rows: [
              { sheet_id: 'sheet_ops', perm_code: 'spreadsheet:read' },
              { sheet_id: 'sheet_ops', perm_code: 'spreadsheet:write-own' },
            ],
          }
        }
        if (sql.includes('SELECT id, sheet_id, name, type, filter_info, sort_info, group_info, hidden_field_ids, config FROM meta_views WHERE id = $1')) {
          expect(params).toEqual(['view_grid_owner'])
          return {
            rows: [{ id: 'view_grid_owner', sheet_id: 'sheet_ops', name: 'Owner Grid', type: 'grid', filter_info: {}, sort_info: {}, group_info: {}, hidden_field_ids: [], config: {} }],
          }
        }
        if (sql.includes('SELECT id, name FROM meta_sheets WHERE id = $1 AND deleted_at IS NULL')) {
          expect(params).toEqual(['sheet_ops'])
          return { rows: [{ id: 'sheet_ops', name: 'Ops' }] }
        }
        if (sql.includes('SELECT id, name, type, property, "order" FROM meta_fields WHERE sheet_id = $1 ORDER BY "order" ASC')) {
          expect(params).toEqual(['sheet_ops'])
          return {
            rows: [{ id: 'fld_name', name: 'Name', type: 'string', property: {}, order: 1 }],
          }
        }
        if (
          sql.includes('SELECT id, version, data, COUNT(*) OVER()::int AS total')
          || sql.includes('SELECT id, version, data FROM meta_records WHERE sheet_id = $1 ORDER BY created_at ASC, id ASC')
        ) {
          expect(params?.[0]).toBe('sheet_ops')
          return {
            rows: [
              { id: 'rec_owned', version: 1, data: { fld_name: 'Mine' }, total: 2 },
              { id: 'rec_foreign', version: 1, data: { fld_name: 'Theirs' }, total: 2 },
            ],
          }
        }
        if (sql.includes('SELECT id, created_by FROM meta_records WHERE sheet_id = $1 AND id = ANY($2::text[])')) {
          expect(params).toEqual(['sheet_ops', ['rec_owned', 'rec_foreign']])
          return {
            rows: [
              { id: 'rec_owned', created_by: 'user_sheet_acl_1' },
              { id: 'rec_foreign', created_by: 'user_sheet_acl_2' },
            ],
          }
        }
        throw new Error(`Unhandled SQL in test: ${sql}`)
      },
    })

    const response = await request(app)
      .get('/api/multitable/view')
      .query({ viewId: 'view_grid_owner' })
      .expect(200)

    expect(response.body.data.meta.permissions.rowActions).toEqual({
      canEdit: false,
      canDelete: false,
      canComment: true,
    })
    expect(response.body.data.meta.permissions.rowActionOverrides).toEqual({
      rec_owned: {
        canEdit: true,
        canDelete: true,
        canComment: true,
      },
    })
  })

  test('returns record-specific row actions and rejects foreign patches when sheet permission is write-own', async () => {
    const { app } = await createApp({
      tokenPerms: ['multitable:read', 'multitable:write', 'comments:write'],
      queryHandler: async (sql, params) => {
        if (sql.includes('FROM spreadsheet_permissions')) {
          expect(params).toEqual(['user_sheet_acl_1', ['sheet_ops']])
          return {
            rows: [
              { sheet_id: 'sheet_ops', perm_code: 'spreadsheet:read' },
              { sheet_id: 'sheet_ops', perm_code: 'spreadsheet:write-own' },
            ],
          }
        }
        if (
          sql.includes('SELECT id, sheet_id, version, data, created_by FROM meta_records WHERE id = $1')
          || sql.includes('SELECT id, sheet_id, version, data FROM meta_records WHERE id = $1')
        ) {
          const recordId = String(params?.[0] ?? '')
          return {
            rows: [{
              id: recordId,
              sheet_id: 'sheet_ops',
              version: recordId === 'rec_owned' ? 3 : 4,
              data: { fld_name: recordId === 'rec_owned' ? 'Mine' : 'Theirs' },
              created_by: recordId === 'rec_owned' ? 'user_sheet_acl_1' : 'user_sheet_acl_2',
            }],
          }
        }
        if (
          sql.includes('SELECT id, sheet_id, created_by FROM meta_records WHERE id = $1')
          || sql.includes('SELECT id, sheet_id FROM meta_records WHERE id = $1')
        ) {
          const recordId = String(params?.[0] ?? '')
          return {
            rows: [{
              id: recordId,
              sheet_id: 'sheet_ops',
              created_by: recordId === 'rec_owned' ? 'user_sheet_acl_1' : 'user_sheet_acl_2',
            }],
          }
        }
        if (sql.includes('SELECT id, base_id, name, description FROM meta_sheets WHERE id = $1')) {
          expect(params).toEqual(['sheet_ops'])
          return { rows: [{ id: 'sheet_ops', base_id: 'base_ops', name: 'Ops', description: null }] }
        }
        if (sql.includes('SELECT id, name, type, property, "order" FROM meta_fields WHERE sheet_id = $1')) {
          expect(params).toEqual(['sheet_ops'])
          return {
            rows: [{ id: 'fld_name', name: 'Name', type: 'string', property: {}, order: 1 }],
          }
        }
        if (sql.includes('SELECT id, version, created_by FROM meta_records WHERE id = $1 AND sheet_id = $2 FOR UPDATE')) {
          const recordId = String(params?.[0] ?? '')
          return {
            rows: [{
              id: recordId,
              version: recordId === 'rec_owned' ? 3 : 4,
              created_by: recordId === 'rec_owned' ? 'user_sheet_acl_1' : 'user_sheet_acl_2',
            }],
          }
        }
        throw new Error(`Unhandled SQL in test: ${sql}`)
      },
    })

    const ownedResponse = await request(app)
      .get('/api/multitable/records/rec_owned')
      .expect(200)
    expect(ownedResponse.body.data.rowActions).toEqual({
      canEdit: true,
      canDelete: true,
      canComment: true,
    })

    const foreignResponse = await request(app)
      .get('/api/multitable/records/rec_foreign')
      .expect(200)
    expect(foreignResponse.body.data.rowActions).toEqual({
      canEdit: false,
      canDelete: false,
      canComment: true,
    })

    const patchResponse = await request(app)
      .delete('/api/multitable/records/rec_foreign')
      .expect(403)
    expect(patchResponse.body).toEqual({
      ok: false,
      error: { code: 'FORBIDDEN', message: 'Record deletion is not allowed for this row' },
    })
  })

  test('rejects field, view, person preset, and sheet management when sheet permission is read-only', async () => {
    const { app } = await createApp({
      tokenPerms: ['multitable:read', 'multitable:write'],
      queryHandler: async (sql, params) => {
        if (sql.includes('FROM spreadsheet_permissions')) {
          if (JSON.stringify(params) === JSON.stringify(['user_sheet_acl_1', ['sheet_ops']])) {
            return { rows: [{ sheet_id: 'sheet_ops', perm_code: 'spreadsheet:read' }] }
          }
        }
        if (sql.includes('SELECT id FROM meta_sheets WHERE id = $1 AND deleted_at IS NULL')) {
          expect(params).toEqual(['sheet_ops'])
          return { rows: [{ id: 'sheet_ops' }] }
        }
        if (sql.includes('SELECT id FROM meta_sheets WHERE id = $1')) {
          expect(params).toEqual(['sheet_ops'])
          return { rows: [{ id: 'sheet_ops' }] }
        }
        if (sql.includes('SELECT id, base_id, name, description FROM meta_sheets WHERE id = $1')) {
          expect(params).toEqual(['sheet_ops'])
          return { rows: [{ id: 'sheet_ops', base_id: 'base_ops', name: 'Ops', description: null }] }
        }
        if (sql.includes('SELECT id, sheet_id FROM meta_fields WHERE id = $1')) {
          expect(params).toEqual(['fld_title'])
          return { rows: [{ id: 'fld_title', sheet_id: 'sheet_ops' }] }
        }
        if (sql.includes('SELECT id, sheet_id, name, type, filter_info, sort_info, group_info, hidden_field_ids, config FROM meta_views WHERE id = $1')) {
          expect(params).toEqual(['view_grid'])
          return {
            rows: [{ id: 'view_grid', sheet_id: 'sheet_ops', name: 'Grid', type: 'grid', filter_info: {}, sort_info: {}, group_info: {}, hidden_field_ids: [], config: {} }],
          }
        }
        if (sql.includes('SELECT id, sheet_id FROM meta_views WHERE id = $1')) {
          expect(params).toEqual(['view_grid'])
          return { rows: [{ id: 'view_grid', sheet_id: 'sheet_ops' }] }
        }
        throw new Error(`Unhandled SQL in test: ${sql}`)
      },
    })

    const responses = [
      await request(app).post('/api/multitable/fields').send({ sheetId: 'sheet_ops', name: 'Blocked Field', type: 'string' }),
      await request(app).post('/api/multitable/person-fields/prepare').send({ sheetId: 'sheet_ops' }),
      await request(app).patch('/api/multitable/fields/fld_title').send({ name: 'Blocked rename' }),
      await request(app).delete('/api/multitable/fields/fld_title'),
      await request(app).post('/api/multitable/views').send({ sheetId: 'sheet_ops', name: 'Blocked View', type: 'grid' }),
      await request(app).patch('/api/multitable/views/view_grid').send({ name: 'Blocked view rename' }),
      await request(app).delete('/api/multitable/views/view_grid'),
      await request(app).delete('/api/multitable/sheets/sheet_ops'),
    ]

    for (const response of responses) {
      expect(response.status).toBe(403)
      expect(response.body).toEqual({
        ok: false,
        error: { code: 'FORBIDDEN', message: 'Insufficient permissions' },
      })
    }
  })

  test('lists sheet permission entries and permission candidates for full sheet writers', async () => {
    const { app } = await createApp({
      tokenPerms: ['multitable:read', 'multitable:write'],
      queryHandler: async (sql, params) => {
        if (sql.includes('SELECT id, base_id, name, description FROM meta_sheets WHERE id = $1')) {
          expect(params).toEqual(['sheet_ops'])
          return { rows: [{ id: 'sheet_ops', base_id: 'base_ops', name: 'Ops', description: null }] }
        }
        if (sql.includes('FROM spreadsheet_permissions') && sql.includes('sheet_id = ANY')) {
          expect(params).toEqual(['user_sheet_acl_1', ['sheet_ops']])
          return { rows: [{ sheet_id: 'sheet_ops', perm_code: 'spreadsheet:write' }] }
        }
        if (sql.includes('FROM spreadsheet_permissions sp') && sql.includes('GROUP BY sp.user_id')) {
          expect(params).toEqual(['sheet_ops'])
          return {
            rows: [
              {
                user_id: 'user_alpha',
                permission_codes: ['spreadsheet:read'],
                name: 'Alpha User',
                email: 'alpha@example.com',
                is_active: true,
              },
              {
                user_id: 'user_beta',
                permission_codes: ['spreadsheet:write-own'],
                name: 'Beta User',
                email: 'beta@example.com',
                is_active: true,
              },
            ],
          }
        }
        if (sql.includes('FROM users u') && sql.includes('LEFT JOIN spreadsheet_permissions sp')) {
          expect(params).toEqual(['sheet_ops', 'alpha', '%alpha%', 20])
          return {
            rows: [
              {
                id: 'user_alpha',
                name: 'Alpha User',
                email: 'alpha@example.com',
                is_active: true,
                permission_codes: ['spreadsheet:read'],
              },
            ],
          }
        }
        throw new Error(`Unhandled SQL in test: ${sql}`)
      },
    })

    const listResponse = await request(app)
      .get('/api/multitable/sheets/sheet_ops/permissions')
      .expect(200)

    expect(listResponse.body.data.items).toEqual([
      {
        userId: 'user_alpha',
        accessLevel: 'read',
        permissions: ['spreadsheet:read'],
        name: 'Alpha User',
        email: 'alpha@example.com',
        isActive: true,
      },
      {
        userId: 'user_beta',
        accessLevel: 'write-own',
        permissions: ['spreadsheet:write-own'],
        name: 'Beta User',
        email: 'beta@example.com',
        isActive: true,
      },
    ])

    const candidatesResponse = await request(app)
      .get('/api/multitable/sheets/sheet_ops/permission-candidates')
      .query({ q: 'alpha' })
      .expect(200)

    expect(candidatesResponse.body.data).toEqual({
      items: [
        {
          id: 'user_alpha',
          label: 'Alpha User',
          subtitle: 'alpha@example.com',
          isActive: true,
          accessLevel: 'read',
        },
      ],
      total: 1,
      limit: 20,
      query: 'alpha',
    })
  })

  test('sets sheet permission access levels through the authoring endpoint', async () => {
    const deleteCalls: Array<unknown[] | undefined> = []
    const insertCalls: Array<unknown[] | undefined> = []

    const { app } = await createApp({
      tokenPerms: ['multitable:read', 'multitable:write'],
      queryHandler: async (sql, params) => {
        if (sql.includes('SELECT id, base_id, name, description FROM meta_sheets WHERE id = $1')) {
          expect(params).toEqual(['sheet_ops'])
          return { rows: [{ id: 'sheet_ops', base_id: 'base_ops', name: 'Ops', description: null }] }
        }
        if (sql.includes('FROM spreadsheet_permissions') && sql.includes('sheet_id = ANY')) {
          expect(params).toEqual(['user_sheet_acl_1', ['sheet_ops']])
          return { rows: [{ sheet_id: 'sheet_ops', perm_code: 'spreadsheet:write' }] }
        }
        if (sql.includes('SELECT id, name, email, is_active FROM users WHERE id = $1')) {
          expect(params).toEqual(['user_target'])
          return { rows: [{ id: 'user_target', name: 'Target User', email: 'target@example.com', is_active: true }] }
        }
        if (sql.includes('DELETE FROM spreadsheet_permissions WHERE sheet_id = $1 AND user_id = $2')) {
          deleteCalls.push(params)
          return { rows: [], rowCount: 2 }
        }
        if (sql.includes('INSERT INTO spreadsheet_permissions(sheet_id, user_id, perm_code) VALUES ($1, $2, $3)')) {
          insertCalls.push(params)
          return { rows: [], rowCount: 1 }
        }
        if (sql.includes('FROM spreadsheet_permissions sp') && sql.includes('GROUP BY sp.user_id')) {
          expect(params).toEqual(['sheet_ops'])
          return {
            rows: [{
              user_id: 'user_target',
              permission_codes: ['spreadsheet:write-own'],
              name: 'Target User',
              email: 'target@example.com',
              is_active: true,
            }],
          }
        }
        throw new Error(`Unhandled SQL in test: ${sql}`)
      },
    })

    const response = await request(app)
      .put('/api/multitable/sheets/sheet_ops/permissions/user_target')
      .send({ accessLevel: 'write-own' })
      .expect(200)

    expect(deleteCalls).toEqual([[
      'sheet_ops',
      'user_target',
      [
        'spreadsheet:read',
        'spreadsheet:write',
        'spreadsheet:write-own',
        'spreadsheets:read',
        'spreadsheets:write',
        'spreadsheets:write-own',
        'multitable:read',
        'multitable:write',
        'multitable:write-own',
      ],
    ]])
    expect(insertCalls).toEqual([['sheet_ops', 'user_target', 'spreadsheet:write-own']])
    expect(response.body.data).toEqual({
      userId: 'user_target',
      accessLevel: 'write-own',
      entry: {
        userId: 'user_target',
        accessLevel: 'write-own',
        permissions: ['spreadsheet:write-own'],
        name: 'Target User',
        email: 'target@example.com',
        isActive: true,
      },
    })
  })

  test('rejects sheet permission authoring for write-own scoped users', async () => {
    const { app } = await createApp({
      tokenPerms: ['multitable:read', 'multitable:write'],
      queryHandler: async (sql, params) => {
        if (sql.includes('SELECT id, base_id, name, description FROM meta_sheets WHERE id = $1')) {
          expect(params).toEqual(['sheet_ops'])
          return { rows: [{ id: 'sheet_ops', base_id: 'base_ops', name: 'Ops', description: null }] }
        }
        if (sql.includes('FROM spreadsheet_permissions') && sql.includes('sheet_id = ANY')) {
          expect(params).toEqual(['user_sheet_acl_1', ['sheet_ops']])
          return { rows: [{ sheet_id: 'sheet_ops', perm_code: 'spreadsheet:write-own' }] }
        }
        throw new Error(`Unhandled SQL in test: ${sql}`)
      },
    })

    const responses = [
      await request(app).get('/api/multitable/sheets/sheet_ops/permissions'),
      await request(app).get('/api/multitable/sheets/sheet_ops/permission-candidates'),
      await request(app).put('/api/multitable/sheets/sheet_ops/permissions/user_target').send({ accessLevel: 'read' }),
    ]

    for (const response of responses) {
      expect(response.status).toBe(403)
      expect(response.body).toEqual({
        ok: false,
        error: { code: 'FORBIDDEN', message: 'Insufficient permissions' },
      })
    }
  })

  test('rejects records summary when sheet permission has no read access', async () => {
    const { app } = await createApp({
      tokenPerms: ['multitable:read'],
      queryHandler: async (sql, params) => {
        if (sql.includes('SELECT id FROM meta_sheets WHERE id = $1 AND deleted_at IS NULL')) {
          expect(params).toEqual(['sheet_locked'])
          return { rows: [{ id: 'sheet_locked' }] }
        }
        if (sql.includes('FROM spreadsheet_permissions')) {
          expect(params).toEqual(['user_sheet_acl_1', ['sheet_locked']])
          return {
            rows: [{ sheet_id: 'sheet_locked', perm_code: 'spreadsheet:comment' }],
          }
        }
        throw new Error(`Unhandled SQL in test: ${sql}`)
      },
    })

    const response = await request(app)
      .get('/api/multitable/records-summary')
      .query({ sheetId: 'sheet_locked' })
      .expect(403)

    expect(response.body).toEqual({
      ok: false,
      error: { code: 'FORBIDDEN', message: 'Insufficient permissions' },
    })
  })

  test('rejects link options when target sheet permission has no read access', async () => {
    const { app } = await createApp({
      tokenPerms: ['multitable:read'],
      queryHandler: async (sql, params) => {
        if (sql.includes('SELECT id, sheet_id, name, type, property FROM meta_fields WHERE id = $1')) {
          expect(params).toEqual(['fld_vendor_link'])
          return {
            rows: [{
              id: 'fld_vendor_link',
              sheet_id: 'sheet_source',
              name: 'Vendor',
              type: 'link',
              property: { foreignSheetId: 'sheet_target' },
            }],
          }
        }
        if (sql.includes('FROM spreadsheet_permissions')) {
          if (JSON.stringify(params) === JSON.stringify(['user_sheet_acl_1', ['sheet_source']])) {
            return { rows: [{ sheet_id: 'sheet_source', perm_code: 'spreadsheet:read' }] }
          }
          if (JSON.stringify(params) === JSON.stringify(['user_sheet_acl_1', ['sheet_target']])) {
            return { rows: [{ sheet_id: 'sheet_target', perm_code: 'spreadsheet:comment' }] }
          }
        }
        if (sql.includes('SELECT id, base_id, name, description FROM meta_sheets WHERE id = $1')) {
          expect(params).toEqual(['sheet_target'])
          return { rows: [{ id: 'sheet_target', base_id: 'base_ops', name: 'Vendors', description: null }] }
        }
        throw new Error(`Unhandled SQL in test: ${sql}`)
      },
    })

    const response = await request(app)
      .get('/api/multitable/fields/fld_vendor_link/link-options')
      .expect(403)

    expect(response.body).toEqual({
      ok: false,
      error: { code: 'FORBIDDEN', message: 'Insufficient permissions' },
    })
  })
})
